---
name: e2e-check
description: Verify a user-facing EventHub flow in a real browser against a production build. Use after building or changing pages, forms, server actions, the wedding website or guest portal, before calling a feature done.
argument-hint: "[path/to/flow-script.cjs]"
allowed-tools: Bash(bash .claude/skills/e2e-check/run-e2e.sh *) Bash(npm run build) Read Write Edit
---

# Browser check (production build, separate database)

Unit tests don't catch React form behaviour, redirects, cookies or layout. Run real flows.

1. Write (or extend) a flow script based on `${CLAUDE_SKILL_DIR}/smoke.cjs`. Keep scripts for a feature
   in your scratchpad, or in `tests/e2e/` if they should be kept. Each step uses `check(cond, "what the
   user can do")` so the output reads as a list of verified behaviours.
2. Run it: `bash .claude/skills/e2e-check/run-e2e.sh <script>` (defaults to the smoke test). It:
   - creates/migrates the **`eventhub_e2e`** database (never the dev DB) and wipes it,
   - builds and starts `next start` on port 3100 with the dev outbox enabled,
   - runs the script with Playwright (pre-installed Chromium), then stops the server.
3. Read OTP codes and sent links from the `dev_outbox` table (see `latest()` in smoke.cjs).
4. Take full-page screenshots of key screens at phone (Pixel 7) and desktop sizes and **look at them**
   (Read the PNG) for layout problems, untranslated text, and light/dark contrast.
5. The run must end with `ok - no client errors`. Report what was verified, what failed, and any bug
   you found and fixed. Don't weaken a check to make it pass.

Gotchas seen in this codebase:
- The header has a "Sign out" submit button: scope clicks to `main button[...]`.
- React form actions reset uncontrolled inputs; assert values after the response, not before.
- A banner already on screen (e.g. `?saved=1`) doesn't prove the latest save finished; wait for
  something the new response adds.
- Guest pages render in the family's language; match English or Hindi text.
- OTP resend cooldown is 30 s per identifier.
