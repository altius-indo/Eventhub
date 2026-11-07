# ADR-0036: Gifts module plans gifts the family gives

- **Status**: Accepted
- **Date**: 2026-11-07
- **Requirements**: GFT-01..GFT-10
- **Supersedes**: [ADR-0027](0027-offline-envelope-queue.md)

## Context

The first Gifts module (GFT v1) tracked gifts the family *received*: a shagun register, a day-of
envelope mode with an offline queue (ADR-0027), cash reconciliation and tally-sheet import, private to
Hosts and Planners with a "gift access" grant. The product owner changed the scope: "it should track
the gift giving not receiving, it should create a list of gifts to be given, when, how many and for
whom optionally and the current status on whether the gifts are already bought or not".

In an Indian wedding the family gives a lot: return gifts for every invited family at a function,
shawls and jewellery for relatives, envelopes for helpers and staff, thank-you gifts for vendors.
Quantities usually follow the guest list ("one box per family at the Sangeet, plus a few spare").

## Options considered

- **Add "given" gifts next to the received register**: keeps everything, but the received side is no
  longer wanted, and the privacy model built for shagun amounts (record-only collectors, in-app-only
  notices) gets in the way of a shared shopping list.
- **Reuse the `gifts` table with a direction flag**: one table, but its columns (giver, envelope
  number, cash hand-over, client keys) don't fit a list of items to buy, and its check constraint
  needs a giver.
- **A new gift list (`gift_items`)** with optional recipient families, and the old tables left in
  place unused until the owner confirms they can be dropped.

## Decision

A new table `gift_items` holds what to give: name, category (return gift, family, helpers and staff,
vendors, other), when (a function and/or a give-by date), how many (a fixed number, or one per
invited family / guest / adult of a function, plus spares), for whom (free text, plus optional
families in `gift_item_recipients`), purchase status (to buy → ordered → bought → given) with the
number bought, unit cost, who's buying and where to buy. Linked quantities are computed live from
`function_invites`, so the count follows the guest list; when it's covered, "to buy"/"ordered"
becomes "bought" automatically, and "given" never moves back.

Hosts and Planners both view and edit the list and the thank-you notes (`gifts.view`,
`gifts.manage`); the "gift access" grant and `gifts.record` are gone (the `gift_access` column stays,
unused). The gift list isn't money that needs Host approval: it is tracked separately from the budget
(families who want it in the budget add a standalone budget line, BGT-02).

A daily job notifies the person buying (or the Hosts) once per item when it isn't fully bought and is
needed within 7 days; changing the item's date re-arms it. Notices carry no costs.

Thank-you notes (GFT-08..10) stay, decoupled from gifts: the tracker covers every family, "attended"
means a member was checked in, and the `{giftItem}` merge field is removed (older templates render
without it).

The legacy tables `gifts`, `cash_handovers` and `gift_imports` stay in the schema, marked legacy, so
no data is dropped by this change; their code (register, envelope mode, offline queue, cash, import,
gift photos) is removed. Two small legacy guards remain until the drop: deleting a family blanks the
name of its old received-gift rows (their check constraint needs a giver once the link is nulled),
and guest erasure still deletes photos attached to them (EVT-09).

## Consequences

- ADR-0027 (offline envelope queue) is superseded; the envelope desk and its localStorage queue are
  gone.
- A follow-up migration drops the legacy tables, types and `documents.gift_id` once the owner
  confirms; the legacy guards in `guests.ts` and `retention.ts` go with it.
- The archive's gifts workbook now holds the gift list and the thank-you tracker.
- Gift notifications (category "gifts") now email by default, since they carry no amounts.
