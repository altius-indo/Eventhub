/**
 * The app's public base URL for links in emails, SMS/WhatsApp, notifications, QR codes and share
 * tags. One place, so no message can fall back to a broken or local address:
 *  1. APP_URL when set (production: the real domain);
 *  2. on Vercel, the address Vercel gives the deployment: the production domain for production,
 *     the branch URL for previews (system environment variables);
 *  3. http://localhost:3000 only on a developer machine.
 * Framework-free so domain code and scripts can use it.
 */
export function resolveAppUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercelHost = env.VERCEL_ENV === "production" ? (env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL) : (env.VERCEL_BRANCH_URL ?? env.VERCEL_URL);
  if (vercelHost) return `https://${vercelHost.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}
