import type { NextConfig } from "next";

/** Non-site areas (see PROTECTED_PREFIXES in src/proxy.ts and RESERVED_SLUGS). */
const APP_PREFIXES = ["/events", "/account", "/admin", "/welcome", "/step-up", "/vendor", "/notifications", "/login", "/dev", "/offline", "/g", "/c", "/u", "/api"];
const APP_CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

const nextConfig: NextConfig = {
  // EventHub is almost entirely authenticated, per-request UI, so we use the
  // standard dynamic rendering model instead of Cache Components.
  cacheComponents: false,
  poweredByHeader: false,
  // HEIC decoding (WASM, ADR-0032): load from node_modules at runtime rather than bundling.
  serverExternalPackages: ["heic-decode", "libheif-js"],
  experimental: {
    // Guest spreadsheets can be up to 5 MB (see MAX_IMPORT_BYTES).
    serverActions: { bodySizeLimit: "6mb" },
    // Documents (contracts, invoices) go to a route handler and may be up to 20 MB (ADR-0018).
    // The proxy buffers request bodies; above this limit they'd be silently truncated.
    proxyClientMaxBodySize: "21mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // HTTPS everywhere (§4 Security). Browsers ignore HSTS on plain-http localhost.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // Camera only for the check-in scanner on our own origin.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
        ],
      },
      // Signed-in app areas, login, guest/pass links and APIs: never framed, no plugins, forms post
      // only to us. (Wedding sites at /<slug> keep X-Frame-Options only; a script-src policy needs
      // per-request nonces and is left for later.)
      ...APP_PREFIXES.map((p) => ({ source: `${p}/:path*`, headers: [{ key: "Content-Security-Policy", value: APP_CSP }] })),
      ...APP_PREFIXES.map((p) => ({ source: p, headers: [{ key: "Content-Security-Policy", value: APP_CSP }] })),
      { source: "/", headers: [{ key: "Content-Security-Policy", value: APP_CSP }] },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
