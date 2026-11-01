# ADR-0025: Per-event messaging quotas reserved at enqueue

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: LIM-01, LIM-02, LIM-03, §4.1

## Context

Each event has lifetime limits per channel (WhatsApp 15,000, SMS 3,000, email 50,000), overridable
by the App Admin. Bulk sends must be blocked at 100% while one-to-one messages and OTPs keep working,
with warnings at 80% and 95%.

## Options considered

- **Count after sending**: accurate, but a broadcast can overshoot the limit by thousands.
- **Reserve at enqueue, settle on send**: the estimate shown before sending equals what is counted.

## Decision

`enqueue` reserves usage in `message_usage` per event and channel; a bulk batch that would exceed the
limit is refused **as a whole** (`QuotaError`) and the broadcast stays a draft. Failed sends release
their reservation. One-to-one messages and OTPs are not blocked. Warnings to Hosts go out once at 80%
and 95% (they count against the limit like any email). Limits come from `platform_settings` and
`event_limit_overrides`.

## Consequences

Partial broadcasts never happen; the family trims the segment or asks for more (LIM-04).
