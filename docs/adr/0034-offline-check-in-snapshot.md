# ADR-0034: Offline check-in snapshot and day-of page caching

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: SEAT-03, SEAT-04 (S), ITN-03, §4 (PWA, venue connectivity), Privacy

## Context

ADR-0014 gave the check-in desk a retry queue, but pass lookup and name search still needed the
server, and a desk opened with no signal didn't load at all. Venues (lawns, basements, hill
resorts) often lose connectivity just as guests arrive. The service worker from M1 also cached
**every** page a member navigated to (guest lists, budgets, gifts), network-first. That helped
offline, but left a lot of personal data in the browser cache.

## Options considered

- **Cache all pages (status quo)**: simple, but stores much more personal data than the day-of
  screens need, and pages can't search offline anyway.
- **IndexedDB guest database with sync**: full offline app, but a large client and conflict handling
  for a "should" requirement.
- **A per-function snapshot in `localStorage`, plus caching only the day-of page shells**: small,
  read-only, and check-ins still go through the idempotent queue (ADR-0014).

## Decision

- `GET /events/<id>/logistics/check-in/<functionId>/api` returns `checkInSnapshot()` for members
  with `checkin.operate` (401 signed out, 404 non-member or other event, `private, no-store`).
  It contains only families with someone invited to, or already checked in at, that function:
  household id, name, side, and per member id, name, age group, invited flag, RSVP and check-in
  time. **No phones, emails, addresses, notes, travel, rooms or gifts.**
- Passes are matched offline by **SHA-256 of the pass token** (`passHash`), computed in the browser
  with `crypto.subtle`. The snapshot never contains a usable pass or guest-link token; regenerating
  or revoking the link changes or clears the hash. Legacy `/g/` QR codes still need a connection.
- The desk downloads the snapshot on load and about once a minute, stores it under
  `eh_checkin_snapshot_<userId>_<functionId>`, and uses it only when the server can't be reached.
  Offline results are labelled with the snapshot time, and queued check-ins are shown on top.
  Offline search covers names only (no phone digits, since phones aren't cached).
- The service worker (v2) caches page HTML only for the live run sheet
  (`/events/<id>/schedule/<fid>/run-sheet/live`) and the check-in desk
  (`/events/<id>/logistics/check-in/<fid>`), network-first, and only without a query string, so a
  `?pass=` URL is never stored. Every other navigation is network-only with the `/offline`
  fallback. Bumping the version deletes the v1 cache that held other pages.

## Privacy trade-off

Names, RSVP and arrival state for one function sit on a staff phone. That's the minimum needed to
let guests in when the network drops. To limit the exposure:

- **Sign out** clears cached pages (service worker message), queued check-ins and every snapshot.
- On load the desk deletes snapshots that belong to another user or function; a 401/403/404 from
  the server (signed out elsewhere, removed from the event, function deleted) deletes them too.
- Everything is removed with the event's data by retention (EVT-07) on the server; a device that
  never comes back online keeps its copy until the browser storage is cleared. We accept this for
  staff devices and mention it in the privacy notice.

## Consequences

The desk works from a cold start without signal, as long as it was opened once online on that
device for that function. Other screens no longer open offline (they show the offline page), which
is intended. If offline needs grow (envelope mode search, run-sheet edits), move to IndexedDB with
the same "minimal fields, cleared on sign-out" rules.
