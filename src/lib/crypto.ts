import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("AUTH_SECRET must be set to a long random string");
  return s;
}

export function hmac(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Six-digit numeric code, uniformly distributed, may start with 0. */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Field encryption for sensitive vendor data (bank details, PAN). AES-256-GCM.
// Key: DATA_ENCRYPTION_KEY (base64url, 32 bytes) or, if unset, derived from AUTH_SECRET.
// ---------------------------------------------------------------------------

function dataKey(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (raw) {
    const k = Buffer.from(raw, "base64url");
    if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64url-encoded");
    return k;
  }
  // Development fallback only; production must set its own key (ADR-0019).
  if (process.env.NODE_ENV === "production") throw new Error("DATA_ENCRYPTION_KEY must be set in production");
  return Buffer.from(hkdfSync("sha256", secret(), "eventhub", "field-encryption-v1", 32));
}

/**
 * Encrypts a short string; output is "v1.<iv>.<tag>.<ciphertext>" (base64url). `context` is bound
 * as additional data (e.g. "vendor:<id>:bank"), so a value can't be moved to another row or field.
 */
export function encryptField(plain: string, context = ""): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", dataKey(), iv);
  c.setAAD(Buffer.from(context, "utf8"));
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptField(value: string, context = ""): string {
  const [v, iv, tag, enc] = value.split(".");
  if (v !== "v1" || !iv || !tag || enc === undefined) throw new Error("Unrecognised encrypted value");
  const d = createDecipheriv("aes-256-gcm", dataKey(), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(context, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}

/** "XXXXXX1234": only the last 4 characters. */
export function mask(value: string | null | undefined, visible = 4): string {
  if (!value) return "";
  return value.length <= visible ? "•".repeat(value.length) : "•".repeat(Math.min(8, value.length - visible)) + value.slice(-visible);
}
