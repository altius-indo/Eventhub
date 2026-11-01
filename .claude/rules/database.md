---
paths:
  - "src/db/**"
  - "src/lib/**/*.ts"
  - "drizzle/**"
  - "scripts/**"
---

# Database (PostgreSQL + Drizzle)

- Schema lives only in `src/db/schema.ts`. After changing it run `npm run db:generate -- --name <what>`,
  then `npm run db:migrate` and migrate the test DB (`npx tsx scripts/migrate.ts $TEST_DATABASE_URL`).
- **Never edit an existing file in `drizzle/`** — migrations are append-only (a hook blocks it).
- Every event-owned table has `event_id ... references events(id) on delete cascade`, so deleting an
  event (retention, EVT-07) removes everything. New tables must follow this.
- Domain functions take `db: Tx` (or `Database` when they open a transaction) and never import Next.
- Multi-step writes go in `db.transaction`. Use `.for("update")` on a parent row to serialise
  invariants (e.g. "at least one Host", +1 allowance).
- Money: integer paise (`bigint mode: "number"`). Dates: `date` columns as `YYYY-MM-DD` strings.
  Travel times are wall-clock times stored as UTC timestamps without conversion (see `travel.ts`).
- Write the audit entry inside the same transaction as the change.
- Prefer one query over N queries; aggregate with `count(*) filter (where ...)`.
- Raw `sql` fragments must use parameters (`${value}`), never string concatenation. `notExists()` /
  `exists()` need a parenthesised subquery — write ``sql`not exists (select ...)` `` instead.
