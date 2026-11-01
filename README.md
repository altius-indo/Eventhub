# EventHub

A web app for planning large, multi-day Indian weddings: itinerary, guests and logistics, vendors, budgets, invoices and payment tracking, and messaging.

- Product requirements: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)

## Status

**Milestone 1 (Foundation)** is built:

- Passwordless login with a one-time code by email, or by phone over SMS/WhatsApp. No passwords. 30-day sliding sessions, device list and sign-out, step-up re-verification for sensitive actions.
- Events: create, edit, delete with a 7-day restore window, and a purge job.
- Team: invite by phone or email as **Host** or **Planner**. An event always keeps at least one Host. Hosts can give Planners gift access (record-only or full).
- Permission policy for App Admin / Host / Planner (§2.1 of the requirements).
- Approval engine: Planner changes go to a Host queue to approve, reject or request changes. Change types plug in from later milestones.
- Activity (audit) log, including App Admin access.
- App Admin console: users (search, suspend, grant admin) and all events.
- English and Hindi, an installable PWA shell with an offline page, and light/dark themes.

## Tech

Next.js 16 (App Router, server actions) · TypeScript · PostgreSQL · Drizzle ORM · Tailwind CSS 4 · Vitest.

## Getting started

Requirements: Node 22+, PostgreSQL 16 (or Docker).

```bash
cp .env.example .env              # then set AUTH_SECRET (command in the file)
docker compose up -d db           # or use your own Postgres; also creates eventhub_test
npm install
npm run db:migrate                # apply migrations to DATABASE_URL
npm run dev                       # http://localhost:3000
```

In development, codes and invitations aren't really sent. They're written to a dev outbox you can read at **http://localhost:3000/dev/outbox**. Log in with any email or Indian mobile number. Emails or phones listed in `APP_ADMIN_IDENTIFIERS` become App Admins when they log in.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js dev server / production build / production server |
| `npm test` | Unit and integration tests (needs `TEST_DATABASE_URL` migrated: `npx tsx scripts/migrate.ts $TEST_DATABASE_URL`) |
| `npm run typecheck` / `lint` | TypeScript and ESLint |
| `npm run db:generate` | Generate a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run jobs:purge` | Permanently delete events past their 7-day restore window (run daily) |

### Message delivery

| Setting | Values |
|---|---|
| `EMAIL_PROVIDER` | `dev` (outbox) or `smtp` (uses `SMTP_URL`, `EMAIL_FROM`) |
| `PHONE_PROVIDER` | `dev` (outbox) or `disabled`. Real SMS (DLT) and WhatsApp providers will be added once templates are approved. |

`dev` providers refuse to run in production unless `ALLOW_DEV_DELIVERY=1` is set.

## Project layout

```
src/
  app/(main)/          pages: login, welcome, step-up, events, account, admin, dev outbox
  app/offline/         static offline page (cached by the service worker)
  components/          UI building blocks
  db/                  Drizzle schema and client
  i18n/                English + Hindi messages, translator, date/currency formatting
  lib/                 domain logic (framework-independent, unit tested)
    auth-core.ts       users, sessions, step-up, invitation acceptance
    otp.ts             one-time codes, rate limits
    policy.ts          role permissions
    approvals.ts       Host approval engine
    events.ts          events, team, invitations
  lib/server/          Next.js glue: cookies, request context, event context
  proxy.ts             redirects signed-out visitors to /login
drizzle/               SQL migrations
public/sw.js           service worker
tests/                 Vitest tests (run against a real Postgres)
```
