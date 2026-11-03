/**
 * Which database to use. Preview deployments must never touch production data (ADR-0035):
 * on Vercel previews (VERCEL_ENV=preview) only the PREVIEW_* connection is used, and if it's
 * missing we fail loudly instead of falling back to the production DATABASE_URL.
 * Framework-free so the migrate script can use it too.
 */
export function databaseUrl(kind: "pooled" | "unpooled" = "pooled", env: Record<string, string | undefined> = process.env): string {
  if (env.VERCEL_ENV === "preview") {
    const url = kind === "unpooled" ? (env.PREVIEW_DATABASE_URL_UNPOOLED ?? env.PREVIEW_DATABASE_URL) : env.PREVIEW_DATABASE_URL;
    if (!url) throw new Error("Preview deployments need their own database: PREVIEW_DATABASE_URL is not set (refusing to use production).");
    return url;
  }
  const url = kind === "unpooled" ? (env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL) : env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}
