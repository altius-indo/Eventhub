---
paths:
  - "src/app/**"
  - "src/proxy.ts"
  - "next.config.ts"
---

# Next.js 16 specifics

- This Next.js is newer than most training data. Check `node_modules/next/dist/docs/` before using an
  API you're unsure of.
- `params`/`searchParams` are Promises; use the generated `PageProps<"/route">`, `LayoutProps<...>`,
  `RouteContext<...>` types (run `npx next typegen` after adding routes).
- Middleware is `src/proxy.ts` (`export function proxy`). It only protects app areas listed in
  `PROTECTED_PREFIXES`; wedding sites (`/<slug>`) and `/g/<token>` are public. New top-level app
  areas must be added there **and** to `RESERVED_SLUGS` in `src/lib/website.ts`.
- `cacheComponents` is off (ADR-0007): pages reading cookies are dynamic; don't add `"use cache"`.
- Cookies can only be set in server actions and route handlers, not while rendering.
