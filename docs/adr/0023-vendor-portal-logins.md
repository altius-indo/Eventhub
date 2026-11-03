# ADR-0023: Vendor portal logins via vendor contacts

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: VND-10, EVT-01b

## Context

Vendors need their own OTP login to see briefs, submit quotes, upload invoices and chat, but they
must never become event members (members see guests, budgets and everything else). One caterer may
work several weddings on EventHub.

## Options considered

- **Make vendors a third member role**: reuses `getEventContext`, but every member-gated page would
  need a vendor exclusion; one missed check leaks guest data.
- **Separate `vendor_contacts` table linking a login to a vendor row**: portal pages have their own
  context and policy subject; staff pages stay unreachable by construction.

## Decision

A `vendor_contacts` row ties a phone/email (and, once accepted, a user) to one vendor row of one
event. Hosts/Planners invite from the vendor page; the first OTP login with that identifier accepts it
(`acceptVendorInvites` in `signInWithIdentifier`). A login that is a member of the same event can't be
its vendor (`is_member`). Portal pages use `getVendorContext`, which re-checks the link on every
request, and policy gives `portal.*` permissions only to a vendor subject. Every portal read filters by
event **and** vendor and selects explicit columns (no estimates, payers or unconfirmed payments).

## Consequences

Vendor isolation is structural rather than a per-page check. Revoking a contact cuts access on the
next request. Vendors who are also family members of the same event need a second identifier.
