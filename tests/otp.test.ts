import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { otpChallenges } from "@/db/schema";
import { OTP_MAX_ATTEMPTS, requestOtp, verifyOtp } from "@/lib/otp";
import { codeFrom, db, outbox, resetDb } from "./helpers";

const email = { type: "email" as const, value: "priya@example.com" };

beforeEach(resetDb);

async function request(now = new Date(), ip = "1.1.1.1", identifier = email) {
  const res = await requestOtp(db(), { purpose: "login", identifier, ip, locale: "en", now });
  if (!res.ok) throw new Error(res.error);
  const msgs = await outbox();
  return { challengeId: res.challengeId, code: codeFrom(msgs[msgs.length - 1].body) };
}

describe("OTP", () => {
  it("sends a code and verifies it once", async () => {
    const { challengeId, code } = await request();
    const [msg] = await outbox();
    expect(msg).toMatchObject({ channel: "email", to: "priya@example.com", subject: "Your EventHub code" });

    // Only a hash is stored
    const [row] = await db().select().from(otpChallenges).where(eq(otpChallenges.id, challengeId));
    expect(row.codeHash).not.toContain(code);

    expect((await verifyOtp(db(), { challengeId, code, purpose: "login" })).ok).toBe(true);
    expect(await verifyOtp(db(), { challengeId, code, purpose: "login" })).toEqual({ ok: false, error: "invalid" });
  });

  it("sends phone codes by SMS or WhatsApp", async () => {
    const phone = { type: "phone" as const, value: "+919876543210" };
    const res = await requestOtp(db(), { purpose: "login", identifier: phone, phoneChannel: "whatsapp", locale: "hi" });
    expect(res).toMatchObject({ ok: true, channel: "whatsapp" });
    const [msg] = await outbox();
    expect(msg.body).toContain("आपका EventHub लॉग इन कोड");
  });

  it("rejects a code for the wrong purpose", async () => {
    const { challengeId, code } = await request();
    expect(await verifyOtp(db(), { challengeId, code, purpose: "step_up" })).toEqual({ ok: false, error: "invalid" });
  });

  it("expires after 5 minutes", async () => {
    const start = new Date();
    const { challengeId, code } = await request(start);
    const later = new Date(start.getTime() + 5 * 60 * 1000 + 1);
    expect(await verifyOtp(db(), { challengeId, code, purpose: "login", now: later })).toEqual({ ok: false, error: "expired" });
  });

  it("locks the code after 5 wrong attempts, even if the right code follows", async () => {
    const { challengeId, code } = await request();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) {
      expect(await verifyOtp(db(), { challengeId, code: wrong, purpose: "login" })).toEqual({ ok: false, error: "invalid" });
    }
    expect(await verifyOtp(db(), { challengeId, code: wrong, purpose: "login" })).toEqual({ ok: false, error: "too_many_attempts" });
    expect(await verifyOtp(db(), { challengeId, code, purpose: "login" })).toEqual({ ok: false, error: "too_many_attempts" });
  });

  it("enforces a 30 second resend cooldown", async () => {
    const start = new Date();
    await request(start);
    const res = await requestOtp(db(), { purpose: "login", identifier: email, locale: "en", now: new Date(start.getTime() + 10_000) });
    expect(res).toEqual({ ok: false, error: "cooldown", retryAfterSeconds: 20 });
  });

  it("allows at most 5 codes per identifier per 15 minutes", async () => {
    const start = Date.now();
    for (let i = 0; i < 5; i++) await request(new Date(start + i * 31_000));
    const res = await requestOtp(db(), { purpose: "login", identifier: email, locale: "en", now: new Date(start + 5 * 31_000) });
    expect(res).toEqual({ ok: false, error: "rate_limited" });
    // A new window opens later
    expect((await requestOtp(db(), { purpose: "login", identifier: email, locale: "en", now: new Date(start + 16 * 60_000) })).ok).toBe(true);
  });

  it("limits requests per IP address", async () => {
    const start = Date.now();
    for (let i = 0; i < 30; i++) {
      await request(new Date(start + i), "9.9.9.9", { type: "email", value: `guest${i}@example.com` });
    }
    const res = await requestOtp(db(), {
      purpose: "login",
      identifier: { type: "email", value: "another@example.com" },
      ip: "9.9.9.9",
      locale: "en",
      now: new Date(start + 100),
    });
    expect(res).toEqual({ ok: false, error: "rate_limited" });
  });

  it("refuses phone codes when phone login is disabled", async () => {
    process.env.PHONE_PROVIDER = "disabled";
    try {
      const res = await requestOtp(db(), { purpose: "login", identifier: { type: "phone", value: "+919876543210" }, locale: "en" });
      expect(res).toEqual({ ok: false, error: "phone_disabled" });
    } finally {
      process.env.PHONE_PROVIDER = "dev";
    }
  });
});
