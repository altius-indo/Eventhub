import { describe, expect, it } from "vitest";
import { resolveAppUrl } from "@/lib/app-url";

describe("resolveAppUrl", () => {
  it("prefers APP_URL and trims trailing slashes", () => {
    expect(resolveAppUrl({ APP_URL: "https://eventhub.example.org/", VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "b.vercel.app" })).toBe("https://eventhub.example.org");
  });
  it("uses Vercel's production domain for production deployments without APP_URL", () => {
    expect(resolveAppUrl({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "eventhub-seven-alpha.vercel.app", VERCEL_URL: "eventhub-abc.vercel.app" })).toBe("https://eventhub-seven-alpha.vercel.app");
  });
  it("uses the branch URL for previews, never localhost", () => {
    expect(resolveAppUrl({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "eventhub-git-x.vercel.app", VERCEL_URL: "eventhub-abc.vercel.app" })).toBe("https://eventhub-git-x.vercel.app");
    expect(resolveAppUrl({ VERCEL_ENV: "preview", VERCEL_URL: "eventhub-abc.vercel.app" })).toBe("https://eventhub-abc.vercel.app");
  });
  it("only falls back to localhost off Vercel", () => {
    expect(resolveAppUrl({})).toBe("http://localhost:3000");
    expect(resolveAppUrl({ APP_URL: "  " })).toBe("http://localhost:3000");
  });
});
