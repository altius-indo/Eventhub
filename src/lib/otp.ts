import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { otpChallenges } from "@/db/schema";
import { createTranslator, type Locale } from "@/i18n/core";
import { generateOtpCode, hmac, safeEqual } from "./crypto";
import { DeliveryError, phoneLoginEnabled, sendMessage, type Channel } from "./delivery";
import type { Identifier } from "./identifiers";
import { isUuid } from "./ids";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
export const OTP_MAX_PER_IDENTIFIER = 5; // per window
export const OTP_IDENTIFIER_WINDOW_MS = 15 * 60 * 1000;
export const OTP_MAX_PER_IP = 30; // per hour

export type OtpPurpose = "login" | "step_up" | "add_identifier";

export type RequestOtpInput = {
  purpose: OtpPurpose;
  identifier: Identifier;
  /** For phone identifiers: "sms" (default) or "whatsapp". */
  phoneChannel?: "sms" | "whatsapp";
  userId?: string;
  ip?: string | null;
  locale: Locale;
  now?: Date;
};

export type RequestOtpResult =
  | { ok: true; challengeId: string; channel: Channel }
  | { ok: false; error: "cooldown"; retryAfterSeconds: number }
  | { ok: false; error: "rate_limited" | "phone_disabled" | "delivery_failed" };

const codeHash = (challengeId: string, code: string) => hmac(`${challengeId}:${code}`);

export async function requestOtp(db: Tx, input: RequestOtpInput): Promise<RequestOtpResult> {
  const now = input.now ?? new Date();
  const { identifier } = input;

  if (identifier.type === "phone" && !phoneLoginEnabled()) return { ok: false, error: "phone_disabled" };

  const [last] = await db
    .select({ createdAt: otpChallenges.createdAt })
    .from(otpChallenges)
    .where(eq(otpChallenges.identifierValue, identifier.value))
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  if (last) {
    const elapsed = now.getTime() - last.createdAt.getTime();
    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      return { ok: false, error: "cooldown", retryAfterSeconds: Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000) };
    }
  }

  const [{ n: recentForIdentifier }] = await db
    .select({ n: count() })
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.identifierValue, identifier.value),
        gt(otpChallenges.createdAt, new Date(now.getTime() - OTP_IDENTIFIER_WINDOW_MS)),
      ),
    );
  if (recentForIdentifier >= OTP_MAX_PER_IDENTIFIER) return { ok: false, error: "rate_limited" };

  if (input.ip) {
    const [{ n: recentForIp }] = await db
      .select({ n: count() })
      .from(otpChallenges)
      .where(and(eq(otpChallenges.ip, input.ip), gt(otpChallenges.createdAt, new Date(now.getTime() - 60 * 60 * 1000))));
    if (recentForIp >= OTP_MAX_PER_IP) return { ok: false, error: "rate_limited" };
  }

  const channel: Channel = identifier.type === "email" ? "email" : (input.phoneChannel ?? "sms");
  const challengeId = crypto.randomUUID();
  const code = generateOtpCode();

  await db.insert(otpChallenges).values({
    id: challengeId,
    purpose: input.purpose,
    identifierType: identifier.type,
    identifierValue: identifier.value,
    channel,
    userId: input.userId,
    codeHash: codeHash(challengeId, code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    ip: input.ip ?? null,
    createdAt: now,
  });

  const t = createTranslator(input.locale);
  const templateKey = input.purpose === "login" ? "otp.login" : input.purpose === "step_up" ? "otp.stepUp" : "otp.addIdentifier";
  try {
    await sendMessage(db, { channel, to: identifier.value, subject: t("otp.subject"), text: t(templateKey, { code }) });
  } catch (err) {
    if (err instanceof DeliveryError) {
      console.error("OTP delivery failed", err);
      return { ok: false, error: "delivery_failed" };
    }
    throw err;
  }
  return { ok: true, challengeId, channel };
}

export type VerifiedChallenge = typeof otpChallenges.$inferSelect;
export type VerifyOtpResult =
  | { ok: true; challenge: VerifiedChallenge }
  | { ok: false; error: "invalid" | "expired" | "too_many_attempts" };

/**
 * Verifies a code. Each call counts as an attempt (incremented atomically before
 * comparing), and a challenge can be consumed only once.
 */
export async function verifyOtp(
  db: Tx,
  input: { challengeId: string; code: string; purpose: OtpPurpose; now?: Date },
): Promise<VerifyOtpResult> {
  const now = input.now ?? new Date();
  const code = input.code.replace(/\s+/g, "");
  if (!isUuid(input.challengeId)) return { ok: false, error: "invalid" };

  const [challenge] = await db
    .update(otpChallenges)
    .set({ attempts: sql`${otpChallenges.attempts} + 1` })
    .where(
      and(
        eq(otpChallenges.id, input.challengeId),
        eq(otpChallenges.purpose, input.purpose),
        isNull(otpChallenges.consumedAt),
      ),
    )
    .returning();

  if (!challenge) return { ok: false, error: "invalid" };
  if (challenge.attempts > OTP_MAX_ATTEMPTS) return { ok: false, error: "too_many_attempts" };
  if (challenge.expiresAt.getTime() <= now.getTime()) return { ok: false, error: "expired" };
  if (!/^\d{6}$/.test(code) || !safeEqual(challenge.codeHash, codeHash(challenge.id, code))) {
    return { ok: false, error: challenge.attempts >= OTP_MAX_ATTEMPTS ? "too_many_attempts" : "invalid" };
  }

  const [consumed] = await db
    .update(otpChallenges)
    .set({ consumedAt: now })
    .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
    .returning();
  if (!consumed) return { ok: false, error: "invalid" };
  return { ok: true, challenge: consumed };
}
