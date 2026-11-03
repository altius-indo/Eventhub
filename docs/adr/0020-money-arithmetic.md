# ADR-0020: Money arithmetic and derived payment statuses

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: BGT-01..06, PAY-01..06, VND-04

## Decision

- **Integer paise everywhere.** User input is parsed from rupee strings and never goes through floats. Budget, booked, invoiced and paid figures include GST; quotes and invoices also keep the pre-tax amount and the tax.
- **Exact splits.** `allocate(total, weights)` uses largest remainder with BigInt products and ties broken by order, so parts always add up to the total. It is used for:
  - package lines over services;
  - the GST of a split line (split by the same weights);
  - payment and invoice amounts spread over a booking's services;
  - shared payer splits;
  - rescaling a payment schedule.
- **GST.** Computed per line from basis points, rounded half away from zero, with CGST and SGST each computed and rounded on their own. The type (CGST+SGST or IGST) is suggested from the vendor's GSTIN state vs the event's place of supply. Invoices keep the printed total; a difference over ₹1 is flagged, not blocked.
- **Statuses are derived, not stored.** Requirement status comes from approval state, lifecycle, coverage and open quote requests. Milestone status works as follows:
  - confirmed payments fill milestones in schedule order;
  - status is paid / overdue / partially paid / due (within 7 days) / upcoming, using the event-local date.
- **Tracking only.** Payments recorded by a Planner don't count until a Host confirms them. A payment above the outstanding balance needs an explicit "record anyway".

## Consequences

Totals are computed live from facts (`budgetFacts`). This is fine at hundreds of requirements; revisit if the budget page exceeds the 300 ms target.
