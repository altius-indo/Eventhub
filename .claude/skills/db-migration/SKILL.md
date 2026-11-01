---
name: db-migration
description: Make a database schema change safely with Drizzle (edit schema, generate SQL migration, apply to dev and test databases, update test helpers). Use whenever src/db/schema.ts changes.
argument-hint: "[short-migration-name]"
allowed-tools: Bash(npm run db:generate *) Bash(npm run db:migrate) Bash(npx tsx scripts/migrate.ts *) Bash(npm test *) Bash(npx vitest *)
---

# Schema change: $ARGUMENTS

1. Edit `src/db/schema.ts` only. New event-owned tables: `eventId ... .references(() => events.id,
   { onDelete: "cascade" })`. Add indexes for lookups/filters. Export the `$inferSelect` types you need.
   A NOT NULL column added to an existing table needs a `.default(...)`.
2. Generate: `npm run db:generate -- --name $0` (snake_case, e.g. `seating_tables`).
3. Read the generated `drizzle/NNNN_*.sql` and check it does what you expect, especially renames
   (drizzle may emit drop + add, losing data) and enum changes. If it's wrong, remove only the files
   you just generated (the SQL, its `drizzle/meta` snapshot and the journal entry), fix the schema and
   regenerate. Never change a migration that's already committed (a hook blocks edits in `drizzle/`).
4. Apply: `npm run db:migrate` and `npx tsx scripts/migrate.ts "$TEST_DATABASE_URL"` (default
   `postgresql://eventhub:eventhub@localhost:5432/eventhub_test`).
5. Add new tables to the `TRUNCATE` list in `tests/helpers.ts` (and in
   `.claude/skills/e2e-check/run-e2e.sh` if they aren't removed by cascades from `events`/`users`).
6. `npm run typecheck && npm test`.
