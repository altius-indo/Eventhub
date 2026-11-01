# ADR-0017: Auto-approve thresholds inside the approval engine

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: BGT-04

## Context

BGT-04 lets Hosts set, per budget category, an amount below which a Planner's bookings and budget changes apply without a Host. The default is ₹0, so everything needs a Host. Anything that pushes a category over its planned total always needs a Host, and payments always need a Host's confirmation.

## Decision

- **Where the threshold lives**: on `service_types` as `auto_approve_below_paise`. Built-in service types and standalone categories (gifts, clothing, other) are the budget categories, so no separate table is needed.
- **How the engine checks it**: handlers may implement `autoApprove(tx, payload, eventId)`. When policy says "approval", `submitChangeTx` calls it and applies the change directly if it returns true. Such changes are audited as `change.auto_approved`.
- **Rules applied**:
  - every category's added amount (incl. GST) must be strictly below its threshold;
  - bookings and booking changes also check for overspend (committed after the change > planned);
  - for a combined quote, each service is checked against its own category with its allocated amount;
  - budget lines check the estimate (or its increase).
- **Never automatic**: payments, cancellations, schedule edits and service/requirement changes have no `autoApprove`, so they always need a Host.

## Consequences

Thresholds can't be set by Planners (`budget.thresholds` is denied to them). Decreases count as "below the threshold". If richer rules are needed (per function, per vendor), they belong in the same hook.
