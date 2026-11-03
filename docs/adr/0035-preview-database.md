# ADR-0035: Preview deployments use their own database

- **Status**: Accepted
- **Date**: 2026-11-03
- **Requirements**: §4 Reliability, Security; EVT-07 (data stays with the event)

## Context

Vercel builds every branch and pull request as a preview, and the build runs `npm run db:migrate`
before `next build`. The production Neon database (`eventhub-db`) was connected to both Production
and Preview, so a branch with a new migration would change the production schema as soon as its
preview built, before review or merge, and previews read and wrote real wedding data.

## Options considered

- **Neon preview branching** (a database branch per deployment, managed by the integration): ideal
  isolation and real-looking data, but configured in the dashboard, and copies of real guest data
  would live in every preview branch.
- **Skip migrations on previews**: protects the schema but previews would still use production data,
  and a branch with a migration couldn't be previewed.
- **A separate preview database** connected to Preview only, plus a code guard: simple, no guest data
  in previews, and migrations are exercised on every preview build.

## Decision

A second free Neon database, `eventhub-preview-db` (sin1), is connected to the Preview environment
only, with the `PREVIEW_` prefix (`PREVIEW_DATABASE_URL`, `PREVIEW_DATABASE_URL_UNPOOLED`). The app
and the migrate script pick the connection through `src/db/url.ts`: when `VERCEL_ENV=preview` they
use only the `PREVIEW_*` variables and fail with an error if those are missing, never falling back to
the production `DATABASE_URL`. Production keeps its existing connection unchanged.

## Consequences

- Preview builds migrate and use the preview database; production is changed only by deployments of
  `main` (Vercel's production branch).
- The preview database starts empty and is shared by all previews; data created there is test data.
- Other preview settings still point at production services: the Blob store (files go under keys of
  preview events, which never collide) and Resend (emails to whoever signs in to a preview). Crons
  run only in production.
- Revisit if previews need realistic data (then use Neon branching with anonymised copies).
