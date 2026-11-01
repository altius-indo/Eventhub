# ADR-0021: Hosting on Vercel with Neon Postgres

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: §7 Hosting, EVT-07, PAY-05, RSV-03, ITN-05

## Context

The first shared deployment goes to Vercel (as §7 suggests), with a Neon Postgres database. Three Vercel limits affect the app:
- Functions refuse request bodies over about 4.5 MB.
- There is no long-running worker, so the daily jobs can't run as scripts.
- Each function instance opens its own database connections.

## Decision

- **Database**: Neon Postgres in Singapore (`sin1`, the closest region to India Neon offers on Vercel). The app uses the pooled connection string (`DATABASE_URL`); migrations use the direct one (`DATABASE_URL_UNPOOLED`). Functions run in `sin1` too.
- **Migrations**: they run during the build (`vercel.json` `buildCommand`). Because migrations are append-only (ADR-0002), a deploy never needs a manual database step.
- **Daily jobs**: they run from one route, `/api/cron/daily`, called by Vercel Cron at 08:01 IST. It covers the purge plus task, RSVP, payment and approval reminders. The route requires `Authorization: Bearer $CRON_SECRET`, and one job failing doesn't stop the others. The `npm run jobs:*` scripts remain for other hosts.
- **Upload limit**: documents are capped at 4 MB on Vercel (20 MB elsewhere; override with `MAX_DOCUMENT_MB`). Larger files wait for object storage in M7.

## Consequences

- Guest spreadsheet imports and documents over about 4 MB fail on Vercel until uploads go to object storage.
- The Hobby plan runs crons once a day, which is all the jobs need.
- A preview deployment shares the production database unless preview gets its own `DATABASE_URL`.
