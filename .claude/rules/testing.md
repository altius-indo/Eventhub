---
paths:
  - "tests/**"
  - "src/lib/**/*.ts"
---

# Testing

- Domain logic in `src/lib` gets Vitest tests in `tests/<module>.test.ts`, run against a real Postgres
  (`TEST_DATABASE_URL`); `beforeEach(resetDb)`. Add new tables to the TRUNCATE in `tests/helpers.ts`.
- Use `makeUser`, `actorOf`, `outbox()` and `codeFrom()` from `tests/helpers.ts`.
- Test behaviour that matters to users and invariants: permissions per role, deadlines across
  timezones, duplicates, last-Host/allowance races, "same answer whether found or not".
- Pass explicit `now` dates for time-dependent logic instead of mocking timers.
- Don't weaken or skip a failing test to get green; fix the code or explain why the test is wrong.
- Browser checks (skill `e2e-check`) run a production build against a separate `*_e2e` database and
  must report zero client-side errors.
