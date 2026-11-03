# ADR-0013: Event deletion: soft delete, undo window, cascade purge

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

Hosts can delete events with a 7-day undo (EVT-09); all event data is deleted 1 year after the event (EVT-07). Data spans many tables.

## Options considered

- Per-table cleanup code.
- `event_id` foreign keys with `on delete cascade` from `events`, plus soft delete.

## Decision

Every event-owned table references `events(id) on delete cascade`. Deleting sets `deleted_at`/`purge_after`; `npm run jobs:purge` hard-deletes after the window. The same mechanism will implement the 1-year retention job.

## Consequences

One `DELETE FROM events` removes everything for an event; new tables must follow the cascade rule (`.claude/rules/database.md`). Backups still need a 35-day purge policy outside the app.
