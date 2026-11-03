import { describe, expect, it } from "vitest";
import { databaseUrl } from "@/db/url";

const PROD = "postgres://prod";
const PROD_DIRECT = "postgres://prod-direct";
const PREV = "postgres://preview";
const PREV_DIRECT = "postgres://preview-direct";

describe("databaseUrl (ADR-0035)", () => {
  it("uses the production database outside previews", () => {
    const env = { DATABASE_URL: PROD, DATABASE_URL_UNPOOLED: PROD_DIRECT, PREVIEW_DATABASE_URL: PREV };
    expect(databaseUrl("pooled", { ...env, VERCEL_ENV: "production" })).toBe(PROD);
    expect(databaseUrl("unpooled", { ...env, VERCEL_ENV: "production" })).toBe(PROD_DIRECT);
    expect(databaseUrl("pooled", env)).toBe(PROD); // local / tests
  });

  it("uses only the preview database on Vercel previews", () => {
    const env = { VERCEL_ENV: "preview", DATABASE_URL: PROD, DATABASE_URL_UNPOOLED: PROD_DIRECT, PREVIEW_DATABASE_URL: PREV, PREVIEW_DATABASE_URL_UNPOOLED: PREV_DIRECT };
    expect(databaseUrl("pooled", env)).toBe(PREV);
    expect(databaseUrl("unpooled", env)).toBe(PREV_DIRECT);
  });

  it("refuses to fall back to production when a preview has no database of its own", () => {
    expect(() => databaseUrl("pooled", { VERCEL_ENV: "preview", DATABASE_URL: PROD })).toThrow(/refusing to use production/);
    expect(() => databaseUrl("unpooled", { VERCEL_ENV: "preview", DATABASE_URL_UNPOOLED: PROD_DIRECT })).toThrow(/refusing to use production/);
  });
});
