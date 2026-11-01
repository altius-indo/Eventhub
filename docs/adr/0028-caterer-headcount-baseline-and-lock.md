# ADR-0028: Caterer headcount: per-booking baseline, lazy freeze at the lock

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: RSV-06, RSV-07, VND-10

## Context

Caterers booked on a Catering service see a live, aggregate headcount for the functions they're
booked for. They must be alerted when the count moves by more than a threshold since they last
looked or acknowledged, and after a "final guarantee" time the count they see must stay frozen while
the team sees later RSVP changes as a delta. RSVPs change at any time (guests, staff, +1s), and we
have only a daily job, no queue or realtime layer.

## Options considered

- **Snapshot on every RSVP write and diff in a trigger**: exact, but couples every RSVP path to
  catering and needs SQL triggers outside Drizzle.
- **Store only the lock time and recompute "as of lock" from history**: RSVPs aren't versioned, so
  the past count can't be reconstructed.
- **Per (booking, function) state row with a baseline and a lazily frozen snapshot** (chosen).

## Decision

- `caterer_headcount_state` keyed by (booking, function) stores the caterer's baseline (snapshot +
  total, set on first view and on "Acknowledge"), the last alerted total, the lock time and the
  frozen snapshot.
- Snapshots are aggregates only (confirmed, maybe, pending; ages, meals and allergy counts of
  confirmed guests), computed from `headcounts()` in `rsvp.ts`. No names or contact details.
- Alerts: when |live − baseline| ≥ `events.headcount_alert_abs` or ≥ `headcount_alert_pct`% of the
  baseline, the caterer's logins and the services' owners get `headcount.changed`, once per move
  (it must also have moved past the threshold since the last alert). Checked by the daily job.
- Lock: `freezeDueLocks()` snapshots every due, unfrozen lock. It runs inside `saveRsvps` before an
  answer is written, whenever a headcount is read (portal and staff booking page) and in the daily
  job, so no post-lock answer can reach the frozen count. Staff can release an updated final count
  (new snapshot, `headcount.locked` notification); moving or clearing the lock time unfreezes.
- Only confirmed bookings show a headcount; split bookings show the function count plus the
  caterer's own contracted quantity vs the requirement quantity.

## Consequences

- No triggers and no background queue; correctness of the freeze doesn't depend on the cron.
- Change alerts arrive at most daily (the daily job); running `checkHeadcountAlerts` after RSVP
  saves would make them immediate if needed.
- One state row per (booking, function); several bookings of the same caterer on one function share
  the earliest booking's baseline for display, and acknowledging updates all of them.
