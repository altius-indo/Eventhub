# ADR-0016: Planner proposals as rows; edits as versioned diffs

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: SVC-10, BGT-04, PAY-03, VND-06

## Context

ADR-0005 introduced approval requests that carry a payload and apply it when a Host approves. SVC-10 also needs a Planner's *new* services and requirements to be visible straight away, but kept out of planned totals and impossible to quote or book. PAY-03 needs a Planner's payment to show as "recorded, awaiting Host confirmation", and BGT-04 needs a Planner's booking to show as tentative.

## Options considered

- **Payload only** (as in M1): nothing exists until approved. Proposals are invisible on the pages where people work, so they can't be attached to, quoted against or listed in the gap view.
- **Rows with a state for creations, payloads for edits**: new items are real rows with `approval_state = proposed`, a booking with `status = pending_approval`, a payment with `state = recorded`. Edits to approved rows are stored as `{id, changes, baseVersion}` in the request.

## Decision

- **New items are rows with a state.** Every total and every list that counts money filters on the approved/confirmed state. Approval flips the state; reject or withdraw calls the handler's `onClosed`, which marks the row rejected (or the booking cancelled).
- **Edits are diffs.** Approved values stay live until a Host approves. The request carries the row's `version`; `apply` refuses a stale request (`ApprovalError("stale")`) if the row changed meanwhile, for example after a direct Host edit.
- **Stored in one transaction.** `submitChangeTx` lets a domain function stage rows and submit the request together. Requests record `entity_type`, `entity_id` and `function_ids`, used for "pending change" badges and to filter the queue by function and type.

## Consequences

Proposals appear in context (function pages, gap view, budget "pending proposals"). Every money query must filter on state; tests cover this. A Planner can edit their own still-proposed row; the Host then approves its latest version. If a requirement or service a booking depends on is cancelled before approval, approving the booking is refused as stale.
