import type { MessageKey, Translator } from "@/i18n/core";
import type { RequestOtpResult, VerifyOtpResult } from "../otp";

type RequestError = Extract<RequestOtpResult, { ok: false }>;
type VerifyError = Extract<VerifyOtpResult, { ok: false }>;

export function requestErrorMessage(t: Translator, res: RequestError): string {
  if (res.error === "cooldown") return t("auth.errors.cooldown", { seconds: res.retryAfterSeconds });
  const keys: Record<Exclude<RequestError["error"], "cooldown">, MessageKey> = {
    rate_limited: "auth.errors.rateLimited",
    phone_disabled: "auth.errors.phoneDisabled",
    delivery_failed: "auth.errors.deliveryFailed",
  };
  return t(keys[res.error]);
}

export function verifyErrorMessage(t: Translator, res: VerifyError): string {
  const keys: Record<VerifyError["error"], MessageKey> = {
    invalid: "auth.errors.invalidCode",
    expired: "auth.errors.expired",
    too_many_attempts: "auth.errors.tooManyAttempts",
  };
  return t(keys[res.error]);
}
