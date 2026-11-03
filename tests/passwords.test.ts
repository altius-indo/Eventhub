import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { passwordResets, sessions, users } from "@/db/schema";
import { createSession } from "@/lib/auth-core";
import {
  checkPasswordStrength,
  hashPassword,
  loginWithPassword,
  requestPasswordReset,
  resetLinkIsValid,
  resetPassword,
  setPassword,
  setRecoveryEmail,
  verifyPassword,
  verifyPasswordStepUp,
} from "@/lib/passwords";
import { db, makeUser, outbox, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH;
  process.env.APP_ADMIN_IDENTIFIERS = "admin@example.com";
});

const GOOD = "Tulsi-Garden-27";

async function admin() {
  process.env.APP_ADMIN_IDENTIFIERS = "admin@example.com";
  const u = await makeUser("admin@example.com", "Jyoti");
  const [a] = await db().update(users).set({ isAppAdmin: true }).where(eq(users.id, u.id)).returning();
  return a;
}

describe("password hashing and strength", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword(GOOD);
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain(GOOD);
    expect(await verifyPassword(GOOD, h)).toBe(true);
    expect(await verifyPassword("Tulsi-Garden-28", h)).toBe(false);
    expect(await verifyPassword(GOOD, "garbage")).toBe(false);
  });

  it("requires length, variety and no common words or email", () => {
    expect(checkPasswordStrength(GOOD)).toBe(true);
    expect(checkPasswordStrength("short1A!")).toBe(false);
    expect(checkPasswordStrength("alllowercaseletters")).toBe(false);
    expect(checkPasswordStrength("MyPassword123!")).toBe(false);
    expect(checkPasswordStrength("Jyoti-2026-xx", "jyoti@example.com")).toBe(false);
  });
});

describe("App Admin password login", () => {
  it("logs an admin in and gives the same answer for unknown emails, non-admins and wrong passwords", async () => {
    const a = await admin();
    await setPassword(db(), { user: a, newPassword: GOOD });
    expect((await loginWithPassword(db(), { email: "ADMIN@example.com", password: GOOD, ip: "1.1.1.1" })).ok).toBe(true);
    const planner = await makeUser("planner@example.com");
    await db().update(users).set({ passwordHash: await hashPassword(GOOD) }).where(eq(users.id, planner.id));
    for (const [email, password] of [
      ["nobody@example.com", GOOD],
      ["planner@example.com", GOOD],
      ["admin@example.com", "Wrong-Pass-99"],
    ]) {
      expect(await loginWithPassword(db(), { email, password, ip: "1.1.1.2" })).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("locks after 5 wrong passwords", async () => {
    const a = await admin();
    await setPassword(db(), { user: a, newPassword: GOOD });
    for (let i = 0; i < 4; i++) await loginWithPassword(db(), { email: "admin@example.com", password: `Wrong-Pass-${i}0`, ip: `9.9.9.${i}` });
    const now = new Date(Date.now() + 16 * 60_000); // new rate-limit window
    await loginWithPassword(db(), { email: "admin@example.com", password: "Wrong-Pass-50", ip: "9.9.9.5", now });
    const r = await loginWithPassword(db(), { email: "admin@example.com", password: GOOD, ip: "9.9.9.6", now });
    expect(r).toEqual({ ok: false, error: "locked" });
  });

  it("accepts the bootstrap hash once for a listed admin email, then stores it", async () => {
    process.env.APP_ADMIN_IDENTIFIERS = "jyoti@example.com";
    process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH = await hashPassword(GOOD);
    const r = await loginWithPassword(db(), { email: "jyoti@example.com", password: GOOD, ip: "2.2.2.2" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.user.isAppAdmin).toBe(true);
    expect(r.user.passwordHash).toBeTruthy();
    // Not for emails outside the admin list.
    expect((await loginWithPassword(db(), { email: "other@example.com", password: GOOD, ip: "2.2.2.3" })).ok).toBe(false);
  });

  it("needs the current password to change it and signs out other devices", async () => {
    const a = await admin();
    await setPassword(db(), { user: a, newPassword: GOOD });
    const [withPw] = await db().select().from(users).where(eq(users.id, a.id));
    const keep = await createSession(db(), a.id, {});
    const other = await createSession(db(), a.id, {});
    await expect(setPassword(db(), { user: withPw, newPassword: "Another-Pass-42", currentPassword: "nope" })).rejects.toMatchObject({ code: "wrong_current" });
    await setPassword(db(), { user: withPw, newPassword: "Another-Pass-42", currentPassword: GOOD, keepSessionId: keep.session.id });
    const rows = await db().select().from(sessions).where(eq(sessions.userId, a.id));
    expect(rows.find((s) => s.id === other.session.id)?.revokedAt).toBeTruthy();
    expect(rows.find((s) => s.id === keep.session.id)?.revokedAt).toBeNull();
    const [fresh] = await db().select().from(users).where(eq(users.id, a.id));
    expect(await verifyPasswordStepUp(db(), fresh, "Another-Pass-42")).toBe("ok");
    expect(await verifyPasswordStepUp(db(), fresh, GOOD)).toBe("invalid");
  });
});

describe("password reset", () => {
  it("emails a single-use link to the login and verified recovery email, then resets and signs out", async () => {
    const a = await admin();
    await setPassword(db(), { user: a, newPassword: GOOD });
    await setRecoveryEmail(db(), a, "backup@example.org");
    await createSession(db(), a.id, {});
    await requestPasswordReset(db(), { email: "admin@example.com", appUrl: "https://app.test", locale: "en" });
    const mails = (await outbox()).filter((m) => m.subject?.includes("Reset"));
    expect(mails.map((m) => m.to).sort()).toEqual(["admin@example.com", "backup@example.org"]);
    const token = mails[0].body.match(/\/login\/reset\/([A-Za-z0-9_-]+)/)![1];
    expect(await resetLinkIsValid(db(), token)).toBe(true);
    await expect(resetPassword(db(), { token, newPassword: "weak" })).rejects.toMatchObject({ code: "weak" });
    await resetPassword(db(), { token, newPassword: "Fresh-Start-77" });
    expect(await resetLinkIsValid(db(), token)).toBe(false);
    await expect(resetPassword(db(), { token, newPassword: "Fresh-Start-88" })).rejects.toMatchObject({ code: "invalid_link" });
    const live = (await db().select().from(sessions).where(eq(sessions.userId, a.id))).filter((s) => !s.revokedAt);
    expect(live).toHaveLength(0);
    expect((await loginWithPassword(db(), { email: "admin@example.com", password: "Fresh-Start-77", ip: "3.3.3.3" })).ok).toBe(true);
  });

  it("sends nothing for non-admins or unknown emails, and links expire", async () => {
    await makeUser("planner@example.com");
    await requestPasswordReset(db(), { email: "planner@example.com", appUrl: "", locale: "en" });
    await requestPasswordReset(db(), { email: "ghost@example.com", appUrl: "", locale: "en" });
    expect((await outbox()).filter((m) => m.subject?.includes("Reset"))).toHaveLength(0);
    const a = await admin();
    await requestPasswordReset(db(), { email: "admin@example.com", appUrl: "", locale: "en" });
    const token = (await outbox()).find((m) => m.subject?.includes("Reset"))!.body.match(/\/login\/reset\/([A-Za-z0-9_-]+)/)![1];
    expect(await resetLinkIsValid(db(), token, new Date(Date.now() + 31 * 60_000))).toBe(false);
    expect((await db().select().from(passwordResets).where(eq(passwordResets.userId, a.id)))[0].tokenHash).not.toBe(token);
  });
});
