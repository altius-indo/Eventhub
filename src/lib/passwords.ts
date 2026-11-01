import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { passwordResets, userIdentifiers, users, type User } from "@/db/schema";
import { createTranslator, type Locale } from "@/i18n/core";
import { audit } from "./audit";
import { AccountSuspendedError, findUserByIdentifier, revokeAllSessions, signInWithIdentifier } from "./auth-core";
import { randomToken, sha256 } from "./crypto";
import { DeliveryError, sendMessage } from "./delivery";
import { allowAttempt } from "./website";

/**
 * Password sign-in for App Admins only (ADR-0022), as a fallback to one-time codes.
 * Everyone else stays passwordless (EVT-01). Passwords are kept only as scrypt hashes.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 32768, r: 8, p: 1 };
const KEYLEN = 64;
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;

export class PasswordError extends Error {
  constructor(public code: "weak" | "wrong_current" | "not_admin" | "invalid_link" | "rate_limited" | "invalid_email") {
    super(code);
  }
}

/** "scrypt$N$r$p$salt$hash" (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((x) => Number.isInteger(x) && x > 0) || params.N > 2 ** 20) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, { ...params, maxmem: 128 * params.N * params.r * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A hash of a random value, verified against when there's no account, so timing doesn't reveal it.
let dummyHash: Promise<string> | undefined;
const dummy = () => (dummyHash ??= hashPassword(randomToken()));

const COMMON = ["password", "123456", "qwerty", "eventhub", "letmein", "welcome", "admin", "iloveyou"];

/** At least 10 characters, three kinds of character, not a common or email-based password. */
export function checkPasswordStrength(password: string, email?: string): boolean {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (kinds < 3) return false;
  const lower = password.toLowerCase();
  if (COMMON.some((c) => lower.includes(c))) return false;
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return false;
  return true;
}

const adminEmails = () =>
  new Set(
    (process.env.APP_ADMIN_IDENTIFIERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );

export type PasswordLoginResult = { ok: true; user: User } | { ok: false; error: "invalid" | "locked" | "rate_limited" | "suspended" };

/**
 * Signs an App Admin in with email and password. The answer is the same whether the email
 * exists, isn't an admin or the password is wrong ("invalid"). 5 wrong tries lock the
 * account for 15 minutes; attempts are also limited per IP.
 *
 * First password: if an admin email (APP_ADMIN_IDENTIFIERS) has no password yet and
 * ADMIN_BOOTSTRAP_PASSWORD_HASH is set, that hash is accepted once and copied to the account.
 */
export async function loginWithPassword(db: Database, input: { email: string; password: string; ip?: string | null; now?: Date }): Promise<PasswordLoginResult> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const password = input.password.slice(0, PASSWORD_MAX);
  if (!(await allowAttempt(db, "password_login_ip", input.ip ?? "unknown", 20, 15 * 60_000, now))) return { ok: false, error: "rate_limited" };
  if (!(await allowAttempt(db, "password_login_email", email, MAX_FAILED_ATTEMPTS, 15 * 60_000, now))) return { ok: false, error: "rate_limited" };

  const user = /^[^@\s]+@[^@\s]+$/.test(email) ? await findUserByIdentifier(db, { type: "email", value: email }) : null;
  const bootstrapHash = process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH;
  const canBootstrap = !!bootstrapHash && adminEmails().has(email) && !user?.passwordHash;

  if (user?.passwordLockedUntil && user.passwordLockedUntil > now) return { ok: false, error: "locked" };

  const stored = user?.isAppAdmin && user.passwordHash ? user.passwordHash : canBootstrap ? bootstrapHash! : null;
  const ok = await verifyPassword(password, stored ?? (await dummy()));
  if (!stored || !ok) {
    if (user) {
      const failed = user.failedPasswordAttempts + 1;
      await db
        .update(users)
        .set({ failedPasswordAttempts: failed >= MAX_FAILED_ATTEMPTS ? 0 : failed, passwordLockedUntil: failed >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MS) : user.passwordLockedUntil })
        .where(eq(users.id, user.id));
      if (failed >= MAX_FAILED_ATTEMPTS) await audit(db, { actor: null, action: "auth.password_locked", entityType: "user", entityId: user.id });
    }
    return { ok: false, error: "invalid" };
  }

  try {
    return await db.transaction(async (tx) => {
      const { user: signedIn } = await signInWithIdentifier(tx, { type: "email", value: email });
      if (!signedIn.isAppAdmin) return { ok: false, error: "invalid" } as const;
      const set: Partial<User> = { failedPasswordAttempts: 0, passwordLockedUntil: null };
      if (!signedIn.passwordHash) Object.assign(set, { passwordHash: stored, passwordChangedAt: now });
      const [updated] = await tx.update(users).set(set).where(eq(users.id, signedIn.id)).returning();
      await audit(tx, { actor: { userId: updated.id, isAppAdmin: true }, action: canBootstrap ? "auth.password_bootstrapped" : "auth.password_login", entityType: "user", entityId: updated.id, ip: input.ip ?? null });
      return { ok: true, user: updated } as const;
    });
  } catch (err) {
    if (err instanceof AccountSuspendedError) return { ok: false, error: "suspended" };
    throw err;
  }
}

/** Sets or changes an App Admin's password. Other sessions are signed out. */
export async function setPassword(db: Database, input: { user: User; newPassword: string; currentPassword?: string | null; keepSessionId?: string; email?: string }) {
  if (!input.user.isAppAdmin) throw new PasswordError("not_admin");
  if (!checkPasswordStrength(input.newPassword, input.email)) throw new PasswordError("weak");
  if (input.user.passwordHash) {
    if (!input.currentPassword || !(await verifyPassword(input.currentPassword, input.user.passwordHash))) throw new PasswordError("wrong_current");
  }
  const hash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: hash, passwordChangedAt: new Date(), failedPasswordAttempts: 0, passwordLockedUntil: null }).where(eq(users.id, input.user.id));
    await revokeAllSessions(tx, input.user.id, input.keepSessionId);
    await audit(tx, { actor: { userId: input.user.id, isAppAdmin: true }, action: "auth.password_changed", entityType: "user", entityId: input.user.id });
  });
}

/** Removes an admin's password (back to codes only). */
export async function removePassword(db: Database, user: User) {
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: null, passwordChangedAt: new Date() }).where(eq(users.id, user.id));
    await audit(tx, { actor: { userId: user.id, isAppAdmin: user.isAppAdmin }, action: "auth.password_removed", entityType: "user", entityId: user.id });
  });
}

/** Password as a step-up (EVT-01d) for admins who have one. Wrong tries count towards the lockout. */
export async function verifyPasswordStepUp(db: Tx, user: User, password: string, now = new Date()): Promise<"ok" | "invalid" | "locked"> {
  if (!user.isAppAdmin || !user.passwordHash) return "invalid";
  if (user.passwordLockedUntil && user.passwordLockedUntil > now) return "locked";
  if (await verifyPassword(password.slice(0, PASSWORD_MAX), user.passwordHash)) {
    await db.update(users).set({ failedPasswordAttempts: 0 }).where(eq(users.id, user.id));
    return "ok";
  }
  const failed = user.failedPasswordAttempts + 1;
  await db
    .update(users)
    .set({ failedPasswordAttempts: failed >= MAX_FAILED_ATTEMPTS ? 0 : failed, passwordLockedUntil: failed >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCKOUT_MS) : null })
    .where(eq(users.id, user.id));
  return "invalid";
}

// ---------------------------------------------------------------------------
// Reset links and the recovery email
// ---------------------------------------------------------------------------

/**
 * Sends a reset link to the admin's login emails and verified recovery email. Same response
 * whether or not the account exists; rate-limited per email and IP.
 */
export async function requestPasswordReset(db: Database, input: { email: string; appUrl: string; ip?: string | null; locale: Locale; now?: Date }) {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  if (!(await allowAttempt(db, "password_reset_ip", input.ip ?? "unknown", 10, 60 * 60_000, now))) throw new PasswordError("rate_limited");
  if (!(await allowAttempt(db, "password_reset_email", email, 3, 60 * 60_000, now))) return;
  const user = /^[^@\s]+@[^@\s]+$/.test(email) ? await findUserByIdentifier(db, { type: "email", value: email }) : null;
  if (!user?.isAppAdmin || user.suspendedAt) return;
  const token = randomToken();
  await db.insert(passwordResets).values({ userId: user.id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + RESET_TTL_MS), ip: input.ip ?? null });
  const ids = await db.select().from(userIdentifiers).where(and(eq(userIdentifiers.userId, user.id), eq(userIdentifiers.type, "email")));
  const to = new Set(ids.map((i) => i.value));
  if (user.recoveryEmail && user.recoveryEmailVerifiedAt) to.add(user.recoveryEmail);
  const t = createTranslator(input.locale);
  const link = `${input.appUrl}/login/reset/${token}`;
  for (const address of to) {
    try {
      await sendMessage(db, { channel: "email", to: address, subject: t("password.resetSubject"), text: t("password.resetEmail", { link }) });
    } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      console.error("Password reset email failed");
    }
  }
  await audit(db, { actor: null, action: "auth.password_reset_requested", entityType: "user", entityId: user.id, ip: input.ip ?? null });
}

async function validReset(db: Tx, token: string, now: Date) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const [row] = await db
    .select({ reset: passwordResets, user: users })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, sha256(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)));
  return row && row.user.isAppAdmin && !row.user.suspendedAt ? row : null;
}

export async function resetLinkIsValid(db: Tx, token: string, now = new Date()) {
  return !!(await validReset(db, token, now));
}

/** Uses a reset link: new password, link spent, every session signed out. */
export async function resetPassword(db: Database, input: { token: string; newPassword: string; now?: Date }) {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const row = await validReset(tx, input.token, now);
    if (!row) throw new PasswordError("invalid_link");
    const [login] = await tx.select().from(userIdentifiers).where(and(eq(userIdentifiers.userId, row.user.id), eq(userIdentifiers.type, "email")));
    if (!checkPasswordStrength(input.newPassword, login?.value)) throw new PasswordError("weak");
    const [spent] = await tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.id, row.reset.id), isNull(passwordResets.usedAt)))
      .returning();
    if (!spent) throw new PasswordError("invalid_link");
    // Other open links for this account stop working too.
    await tx.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, row.user.id), isNull(passwordResets.usedAt)));
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(input.newPassword), passwordChangedAt: now, failedPasswordAttempts: 0, passwordLockedUntil: null })
      .where(eq(users.id, row.user.id));
    await revokeAllSessions(tx, row.user.id);
    await audit(tx, { actor: null, action: "auth.password_reset", entityType: "user", entityId: row.user.id });
  });
}

/** Sets the recovery email once its code is verified (the caller verifies the code). */
export async function setRecoveryEmail(db: Database, user: User, email: string | null) {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ recoveryEmail: email, recoveryEmailVerifiedAt: email ? new Date() : null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await audit(tx, { actor: { userId: user.id, isAppAdmin: user.isAppAdmin }, action: email ? "auth.recovery_email_set" : "auth.recovery_email_removed", entityType: "user", entityId: user.id });
  });
}
