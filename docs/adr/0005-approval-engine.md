# ADR-0005: Generic approval engine for Planner changes

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

Planners' changes to services/requirements, bookings, budget and payments need a Host's approval; any one Host can approve (SVC-10, BGT-04). These modules are built in later milestones, so the mechanism must exist first.

## Options considered

- Per-module "pending" flags and approval screens.
- A generic request queue with pluggable apply handlers.

## Decision

`src/lib/approvals.ts`: `submitChange()` applies directly for Hosts or creates an `approval_requests` row for Planners; `decideRequest()` (approve / reject / request changes, comment required for the last two) applies the registered handler in the same transaction. Handlers are registered per change type in `src/lib/approval-handlers.ts`.

## Consequences

One approval queue and audit trail for every module. Payloads are JSON, so handlers must validate them on apply. Revisit if per-category auto-approve thresholds need richer rules.
