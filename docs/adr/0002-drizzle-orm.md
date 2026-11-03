# ADR-0002: Drizzle ORM instead of Prisma

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

The original plan named Prisma. Prisma 7 needs a native schema-engine binary downloaded from `binaries.prisma.sh`, even for `prisma generate`; that host is blocked in our build environment, and native binaries complicate deployment generally.

## Options considered

- Prisma with pre-fetched engines: fragile, environment-specific.
- Kysely + hand-written migrations: good typing, but more migration work.
- Drizzle ORM + drizzle-kit: pure TypeScript, SQL-like API, generated SQL migrations, no binaries.

## Decision

Use Drizzle ORM (`drizzle-orm/node-postgres`, `pg` pool) with the schema in `src/db/schema.ts` and SQL migrations generated into `drizzle/` and applied by `scripts/migrate.ts`. Never use `drizzle-kit push`.

## Consequences

No binary downloads; migrations are readable SQL we review and commit (append-only, enforced by a hook). We write slightly more SQL for complex queries (`sql` template), which we accept. Revisit only if Drizzle stops keeping up with Postgres features we need.
