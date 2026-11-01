---
paths:
  - "src/app/**/*.{ts,tsx}"
  - "src/lib/server/**/*.ts"
---

# Server actions and pages

- Start every event page/action with `const ctx = await getEventContext(eventId)`. It 404s non-members
  (so event ids don't leak) and lets App Admins in with audit logging. Then check `ctx.can("<perm>")`
  or `ctx.decide(...)` — never compare roles by hand.
- Actions return `{ error?: string; info?: string }` (translated strings) and are used with `SimpleForm`,
  which keeps typed values on error and resets on success. Use plain `<form action>` only for one-click
  buttons without feedback.
- **Pass identifiers by `.bind(null, ...)`**, not hidden inputs or button `name/value`, when a button
  uses `formAction={serverAction}`: React overwrites that button's `name`, so its value never arrives.
- `redirect()` and `notFound()` throw — call them outside `try/catch`, or rethrow non-domain errors.
- Catch only domain errors (`EventError`, `GuestError`, `RsvpError`, `WebsiteError`, `ForbiddenError`,
  …) and map `err.code` to `t("...errors.<code>")`. Let everything else throw.
- Re-derive ownership on the server: ids from the form must be checked by the domain function
  (e.g. `saveRsvps` rejects (guest, function) pairs not invited in that household).
- After a mutation: ``revalidatePath(`/events/${eventId}`, "layout")`` when counts in the tabs/dashboard
  change, otherwise the specific page.
- Success banners after redirects use a query flag (`?saved=1`) — don't rely on a banner inside a
  component that may disappear after the mutation.
- Route handlers that return files set `Cache-Control: private, no-store` unless the data is public.
- Large uploads: server actions accept up to 6 MB (`next.config.ts`); validate type and size again.
