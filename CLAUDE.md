# EventHub

Web app for planning large, multi-day Indian weddings: guests and families, functions and itinerary,
RSVPs, travel, vendors, budgets and payments, messaging, and a wedding website. Families (Hosts) and
their Planners use it; App Admins run the platform; guests use personal links (no login).

- Product requirements (source of truth for scope and IDs like `RSV-03`): @docs/REQUIREMENTS.md
- Architecture decisions: `docs/adr/` (read the relevant ADR before changing an area it covers)
- Next.js version notes: @AGENTS.md

## Commands

```bash
npm run dev                  # http://localhost:3000 (codes/invites land in /dev/outbox)
npm test                     # Vitest against TEST_DATABASE_URL (real Postgres)
npm run typecheck && npm run lint
npm run build                # production build; run before declaring a milestone done
npm run db:generate          # after editing src/db/schema.ts -> new SQL in drizzle/
npm run db:migrate           # apply to DATABASE_URL; test DB: npx tsx scripts/migrate.ts $TEST_DATABASE_URL
npm run jobs:purge | jobs:reminders | jobs:rsvp-reminders   # daily jobs
```

Before saying work is done: `npm run typecheck && npm run lint && npm test`, and `npm run build`
for anything touching routes. For user-facing flows, also run a browser check (skill: `e2e-check`).

## Stack

Next.js 16 App Router (server components + server actions, `proxy.ts`, Cache Components **off**) ·
TypeScript strict · PostgreSQL + Drizzle ORM (ADR-0002) · Tailwind 4 with CSS-variable tokens ·
Vitest · exceljs, sharp, qrcode, nodemailer. No auth library: in-app OTP + DB sessions (ADR-0003).

## Layout

```
src/db/schema.ts        all tables; Drizzle migrations in drizzle/ (generated, never hand-edited)
src/lib/*.ts            domain logic, framework-free, takes `db: Tx` — unit/integration tested
src/lib/server/*.ts     Next glue ("server-only"): session, event context, form parsing, labels
src/app/(main)/         signed-in app (AppShell): events/[eventId]/{guests,schedule,rsvp,website,tasks,...}
src/app/(site)/[slug]/  public wedding website + a family's personal page (guest portal)
src/app/g/[token]/      guest link handler (sets per-event cookie, redirects to the site)
src/components/         UI building blocks (ui.tsx tokens, SimpleForm, SubmitButton, ...)
src/i18n/               en.ts (source) + hi.ts (typed as Messages) + core.ts (translator, formatters)
tests/                  *.test.ts per domain module; helpers.ts has resetDb/makeUser
```

## Core concepts (don't re-derive these)

- **Roles**: App Admin (platform, full access, audited), Host, Planner; plus Vendor and Guest later.
  All permission checks go through `src/lib/policy.ts` `decide()` → `allow | approval | deny` (ADR-0004).
- **Approvals**: Planner changes to services/requirements, bookings, budget and payments are submitted
  via `submitChange()` in `src/lib/approvals.ts`; any Host approves. Register handlers in
  `src/lib/approval-handlers.ts` (ADR-0005).
- **Event scoping**: every event-owned row has `event_id`; every query filters by it. Pages and actions
  start with `getEventContext(eventId)` (404s non-members; logs App Admin access).
- **Audit**: money, RSVP, permissions, deletions and admin actions call `audit()`; add i18n text under
  `audit.actions.<action>` for anything shown in the Activity log.
- **Guest links**: `/g/<token>` = household id + HMAC(id, linkVersion). Bump `linkVersion` to
  invalidate (ADR-0006). Guests never see other families' data.
- **Data retention**: 1 year after the event, then deletion (EVT-07). No government ID collection.

## Conventions

- Mutations are server actions in a colocated `actions.ts`; validate with zod; return
  `{ error?, info? }` for `SimpleForm`; `revalidatePath(...)`; `redirect()` outside try/catch.
- Never trust ids from forms: re-check ownership in the domain function (e.g. guest belongs to household).
- Every user-facing string goes in **both** `en.ts` and `hi.ts` (parity test enforces it).
- Money in integer paise; dates as `YYYY-MM-DD` strings; times in the event timezone (`Asia/Kolkata`).
- Mobile-first, 44px tap targets, works in light and dark mode, no horizontal scroll at 360px.
- Keep `src/lib` free of Next imports so it stays testable; put Next-specific code in `src/lib/server`.

Detailed, path-scoped rules live in `.claude/rules/` and load when you touch matching files.

## Working style

- Read the requirement IDs you're implementing and quote them in commit messages/PRs.
- Record significant technical choices as a new ADR (skill: `adr`).
- Subagents in `.claude/agents/` cover review, security, QA, Hindi translation, architecture and
  requirements; prefer them for independent review rather than self-review.
- Commit on the session's feature branch only; never push to main.
