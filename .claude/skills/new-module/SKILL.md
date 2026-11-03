---
name: new-module
description: Build a new EventHub feature module end to end (schema, domain logic, tests, server actions, pages, translations, navigation) following the project's established pattern. Use when implementing a requirement area such as seating, transfers, rooms, vendors, budget or messaging.
argument-hint: "[module name] [requirement IDs, e.g. SEAT-01..04]"
---

# New feature module: $ARGUMENTS

Follow the same shape as `guests`, `functions`, `tasks` and `rsvp`. Work in this order and keep each
step green before moving on.

1. **Scope.** Read the requirement IDs in `docs/REQUIREMENTS.md` (and the permission matrix §2.1).
   List what's in and out for this pass. If a choice is the user's to make, ask; otherwise pick the
   conventional default and note it. Check `docs/adr/` for decisions that constrain the design.
2. **Permissions.** Map each action to a permission in `src/lib/policy.ts` (add new ones to the
   `permissions` list and to `PLANNER` with `allow | approval`). Money/service changes by Planners are
   `approval` and go through `submitChange()` with a handler in `src/lib/approval-handlers.ts`.
3. **Schema.** Add tables to `src/db/schema.ts` with `event_id ... on delete cascade`, indexes for the
   filters you'll run, and exported types. Then use the `db-migration` skill.
4. **Domain logic** in `src/lib/<module>.ts`: zod input schemas, functions taking `db`, a domain error
   class with `code`s, transactions + row locks for invariants, `audit()` for sensitive changes.
   No Next imports.
5. **Tests** in `tests/<module>.test.ts`: happy path, permission/ownership rejections, invariants,
   time-zone and deadline edges. `npm test` must pass.
6. **Strings**: every label/message in `en.ts` and `hi.ts` (`i18n-strings` skill; the
   `hindi-translator` agent can review).
7. **UI**: pages under `src/app/(main)/events/[eventId]/<module>/` with `getEventContext` +
   `ctx.can(...)`, colocated `actions.ts`, `SimpleForm` forms, components in `src/components/`.
   Add a tab in `events/[eventId]/layout.tsx` and a dashboard card if useful. Add any new top-level
   route to `PROTECTED_PREFIXES` (proxy) and `RESERVED_SLUGS`.
8. **Verify**: `npm run typecheck && npm run lint && npm test && npm run build`, then the `e2e-check`
   skill for the main flows (phone + desktop screenshots, zero client errors).
9. **Review**: ask the `code-reviewer` and `security-reviewer` agents to review the diff; fix findings.
10. **Record**: an ADR for any significant decision (`adr` skill); README "Status" section.
