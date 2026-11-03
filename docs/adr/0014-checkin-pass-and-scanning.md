# ADR-0014: Separate check-in pass, browser QR scanning, idempotent check-in

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: SEAT-03, SEAT-04 (S), ITN-04, §4 (venue connectivity)

## Context

Check-in at the venue is done by Hosts/Planners on phones, often with poor connectivity. The guest
page's "entry pass" QR (milestone 3) encoded `/g/<token>`, the family's portal login link
(ADR-0006): anyone who photographed the pass could change that family's RSVP and travel, and a
planner scanning it with the phone camera would pick up the family's guest cookie. `BarcodeDetector`
exists on Chrome Android but not iOS Safari. We prefer few dependencies.

## Options considered

- Keep the guest link in the QR: simplest, but leaks portal access.
- A random pass code stored per family: needs storage and rotation logic.
- A second HMAC purpose over the same (household id, linkVersion): no storage, rotates with the link.
- Scanning: a QR library everywhere; `BarcodeDetector` only; or `BarcodeDetector` with a lazy fallback.
- Sync: server actions (IDs change per deploy) or a JSON route handler.

## Decision

- The pass QR encodes `/c/<passToken>`, an HMAC with purpose `checkin-pass` over the household id
  and `linkVersion`. Opening it shows a neutral "entry pass" page with no names and sets no cookie; a
  signed-in member with `checkin.operate` is redirected to the check-in desk with the pass.
  Regenerating or revoking the guest link also invalidates the pass. The scanner still accepts
  legacy `/g/` QRs from screenshots taken before this change.
- Scanning uses `BarcodeDetector` when it supports QR, otherwise dynamically imported `jsqr`.
- Check-ins are unique per (function, guest) and inserted with `ON CONFLICT DO NOTHING`, so retries
  and two gates never double count. The desk keeps a retry queue in `localStorage` and flushes it
  to a same-origin JSON route handler (stable across deploys). Device times are clamped.
- New permission `checkin.operate` (Host and Planner). No new role in v1.

## Consequences

A leaked pass reveals nothing. One small dependency, loaded only by the scanner. Pass lookup and
search still need a connection; full offline check-in (cached guest list, cold-start offline) is
deferred to milestone 7. Rotating `AUTH_SECRET` invalidates passes as well as links. A future
"gate helper" role only needs `checkin.operate`.
