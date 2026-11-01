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

**Milestone 2 (Guests & Itinerary)** is built:

- Families (households) with members: relation, age group, phone, email, food preference, accessibility notes, tags; bride/groom/both sides; postal address.
- Functions (Mehendi, Sangeet, …) with date, time, venue, map link and dress code. A day-by-day master schedule with invited headcounts, and calendar (.ics) export.
- Invitations per function at family or member level. New members inherit the head's invitations. Bulk invite or remove everyone matching a filter.
- Guest list search and filters (side, tag, function, "not invited", age, food), saved views, pagination by family.
- Excel/CSV import: column matching (also Hindi headers), validation and duplicate report, then confirm. Excel export that can be imported back, plus a template.
- Task checklist with due dates, assignees, function links, priority, comments, a standard 22-item wedding checklist, and daily reminders (`npm run jobs:reminders`).

**Milestone 3 (Guest experience)** is built:

- A personal link per family (`/g/<token>`, signed, so nothing secret is stored). Share it by copy, WhatsApp (pre-filled message) or SMS/email. Make a new link (old ones stop working) or turn it off. Each family has a language (English/Hindi).
- RSVP per person and function: attending / maybe / not attending, food preference and allergies. A deadline after which guests can't change replies. Families can add +1s or children up to an allowance. Hosts and Planners can record replies on a family's behalf. Daily reminders go to families who haven't replied (`npm run jobs:rsvp-reminders`).
- Headcount per function (attending / maybe / declined / no reply, by side, age and food, allergies), and an Excel export for caterers with a sheet per function. The guest list filters by RSVP and travel status.
- Guest travel: arrival/departure, flight/train, pickup/drop needed. Guests fill it in themselves (with "same for the whole family"), or the team does.
- Wedding website at `/<couple-slug>`:
  - Three themes and eight accent colours, a monogram and cover photo.
  - Sections (welcome, story, events, travel, FAQs, gallery, gift note, contact) that can be shown, hidden and reordered, written in English and Hindi.
  - Draft and preview; publishing needs a Host.
  - Visibility: unlisted (noindex), passcode, or public.
  - Functions are public or private; venue addresses can be limited to invited guests.
  - "Find my invitation" sends the family's link without revealing who is on the list.
  - Link-preview image, a QR code for printed cards, and calendar files.
- The family's personal page doubles as the guest portal: their functions (including private ones), replies, food, +1s, travel, an entry-pass QR code, and their own calendar file. It works even before the site is published.

**Milestone 4 (Logistics and run sheet)** is built:

- Arrivals and departures board by day and time window, with who still needs a pickup or drop.
- Transfers: pickup, drop and shuttle runs (vehicle, driver, capacity, time). Assign guests from the board, see capacity warnings, and print a manifest with one contact number per family.
- Hotels and room blocks (room type, rooms blocked, rate, dates). Assign guests to rooms with their own dates, see occupancy warnings per night, and download the rooming list in Excel (names, room, dates and a contact phone; no ID data).
- Seating per function: add tables, seat whole families or move people, see unseated guests and warnings (over capacity, family split, seated but declined). Print the plan.
- Check-in at the door: each family's entry pass (`/c/<token>`, separate from their personal link) is scanned with the phone camera, or the team searches by name or the last 4 digits of a phone number. Walk-ins can be added. Live arrived vs expected counts. Check-ins made while offline are saved on the phone and sent when the connection returns.
- Run sheet per function: timed items with owner, place, notes and status. Fixed-time items (e.g. the muhurat) stay put when later items are moved. A live "now / next / running late" view for the day, and print pages for the run sheet and the full itinerary.
- Families see their pickup, room and table on their personal page only if the event chooses to share them.

**Milestone 5 (Services, vendors and money)** is built:

- Services per function from a catalogue (catering, decor, photography and more, plus your own), each with requirements: quantity, details, timing and place, estimate, priority and who pays. Status comes from bookings: open, quoting, partly booked, booked, delivered. A gap view lists what's still to book, soonest first.
- Planner changes to services, requirements, bookings, budget and payments go to a Host for approval. Proposals show straight away but stay out of the totals. Hosts can set a per-category limit below which Planner changes apply automatically (₹0 by default); anything over plan always needs a Host, and so do payments (with a one-time code). Hosts get a daily reminder about waiting requests.
- Vendor directory with GSTIN, PAN and bank details. PAN and bank details are encrypted, shown masked, and shown in full only after a one-time code (logged).
- Quote requests for one or many services across functions, with a brief to print or send on WhatsApp. Quotes are entered per requirement, with service extras and package-level discounts or charges spread over services; revisions are versioned. Compare quotes per service, or a package against the cheapest separate quotes.
- Booking a whole quote or part of it, split across vendors, with package conditions (all-or-nothing, minimum functions). A booking creates the commitment and a payment schedule, plus a place for contract terms, key dates (reminded as tasks) and documents (PDFs/photos up to 20 MB).
- Budget by function, service type, vendor and who pays (bride's family, groom's family, or shared), with planned, booked, invoiced and paid, lakh/crore figures and over-plan highlights. Other costs (e.g. return gifts) can be added.
- Invoices with GST (CGST+SGST or IGST, suggested from the vendor's GSTIN), payments (UPI, bank, cheque, cash, card), statuses per milestone and invoice, a payables list with Excel export, and daily payment reminders (`npm run jobs:payment-reminders`, `npm run jobs:approval-reminders`).

**Milestone 6 (Communication)** is built:

- Chat: a team channel, a thread per function and per vendor, with @mentions, attachments and unread counts (refreshes every few seconds).
- Guest broadcasts to a segment (side, tag, function, RSVP status, travel, hotel) by WhatsApp, email or SMS, with a recipient and quota estimate before sending, delivery stats and a one-click unsubscribe. Each family gets its own guest link.
- Notification centre with a bell, plus email preferences per category. A usage page shows messages sent against each channel's limit, with warnings at 80% and 95%.
- Vendor portal: invite a vendor by phone or email; they log in with a one-time code to see their requests and briefs, submit and revise quotes, follow bookings and payment status, upload invoices, see their run-sheet items and chat with the team.
- Caterers see the live headcount for the functions they're booked on (totals only, no names), get alerts when it moves, can acknowledge it and export it. Planners can lock a final count before the function.
- Gifts (Hosts, or Planners with gift access): gift register, a fast envelope mode that works offline, cash hand-over with discrepancy alerts, tally-sheet import, summaries and families with no gift recorded.
- Thank-you notes: tracker, templates in English and Hindi (amounts are never included), review and bulk send, printed-card labels, and a reminder 4 weeks after the wedding.
- Messages are sent through a retrying queue. Email works via Resend; WhatsApp and SMS show "not connected" until provider accounts are set up.

**Milestone 7 (Post-event & hardening)** is built:

- Photo gallery per function: albums, uploads from the family, photographers (vendor portal) and guests (from their personal link), with progress and resume; previews made automatically (HEIC included); review queue for guest uploads; release per album with a one-time "your photos are ready" message; favourites and an album selection shared with the photographer; likes, comments and removal requests; optional watermark; highlights on the wedding website; download-all in parts. Guests only see released photos of functions they were invited to, and downloads have location data removed.
- Files live in private Vercel Blob storage (Mumbai) with per-event limits (250 GB; 300 items / 5 GB per family) and warnings at 80% and 95%.
- Data retention: deletion one year after the last function, reminders at 60, 30 and 7 days (never deleted without notice), a one-click archive (Excel, printable pages, documents, gallery), and guest erasure requests.
- Offline check-in (cached guest list and pass lookup), dashboard RSVP funnel, headcount and arrivals, more Excel exports, faster guest search, and security headers.
- Easier navigation: opens the last event you used, an event switcher and logo, a menu button on phones, simpler search and filters for guests and tasks.

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
| `npm run jobs:reminders` | Remind assignees of tasks due by tomorrow or overdue (run daily, e.g. 08:00 IST) |
| `npm run jobs:rsvp-reminders` | Remind families who haven't replied, in the 14 days before the RSVP deadline, every 3 days (run daily) |

### Deploying to Vercel

See [ADR-0021](docs/adr/0021-hosting-on-vercel.md). In the Vercel project, set `DATABASE_URL` (Neon pooled connection string), `AUTH_SECRET`, `DATA_ENCRYPTION_KEY`, `CRON_SECRET`, `APP_URL` and email settings (`EMAIL_PROVIDER=resend` with `RESEND_API_KEY` and `EMAIL_FROM`, or SMTP). Each deploy runs the migrations, then builds. Vercel Cron calls `/api/cron/daily` every morning (08:01 IST) for the reminders and the purge. On Vercel, documents are limited to 4 MB.

### Message delivery

| Setting | Values |
|---|---|
| `EMAIL_PROVIDER` | `dev` (outbox), `smtp` (uses `SMTP_URL`, `EMAIL_FROM`) or `resend` (uses `RESEND_API_KEY`, `EMAIL_FROM`) |
| `PHONE_PROVIDER` | `dev` (outbox) or `disabled`. Real SMS (DLT) and WhatsApp providers will be added once templates are approved. |

`dev` providers refuse to run in production unless `ALLOW_DEV_DELIVERY=1` is set.

## Working with Claude Code

This repo is set up for Claude Code:

| Where | What |
|---|---|
| `CLAUDE.md` | Project memory: commands, stack, layout, core concepts, conventions |
| `.claude/rules/*.md` | Path-scoped rules that load when matching files are touched (server actions, database, i18n, security & privacy, testing, UI, Next.js 16) |
| `.claude/settings.json` | Shared permissions and hooks |
| `.claude/hooks/` | Session status on start; blocks edits to `.env` and generated migrations; blocks force-push, pushes to main and reading secrets; lints each edited file, checks English/Hindi parity, reminds about migrations; typechecks before Claude finishes |
| `.claude/skills/` | `/new-module`, `/db-migration`, `/e2e-check` (browser test against a production build and a separate `eventhub_e2e` database), `/adr`, `/i18n-strings`, `/ship-milestone` |
| `.claude/agents/` | Roles: `product-analyst`, `architect`, `module-builder` (isolated worktree), `code-reviewer`, `security-reviewer`, `qa-tester`, `hindi-translator` |
| `docs/adr/` | Architecture decision records (13 so far) |

Personal overrides go in `CLAUDE.local.md` and `.claude/settings.local.json` (both git-ignored).

## Project layout

```
src/
  app/(main)/          pages: login, welcome, step-up, events, account, admin, dev outbox
  app/(site)/[slug]/   the public wedding website and each family's personal page
  app/g/[token]/       guest link handler
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
    guests.ts          families, guests, invitations, filters, saved views
    guest-import.ts    spreadsheet parsing, column mapping, preview, import, export
    functions.ts       functions, master schedule, calendar export
    tasks.ts           task checklist, default template, reminders
    guest-links.ts     signed per-family links, sending and sharing
    rsvp.ts            replies, +1s, deadline, headcounts, reminders
    travel.ts          guest arrival/departure details
    website.ts         wedding website content, slugs, visibility, images, publishing
  lib/server/          Next.js glue: cookies, request context, event context
  proxy.ts             redirects signed-out visitors to /login
drizzle/               SQL migrations
public/sw.js           service worker
tests/                 Vitest tests (run against a real Postgres)
```
