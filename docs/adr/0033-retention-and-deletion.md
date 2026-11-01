# ADR-0033: Retention, archive and deletion of event data

- **Status**: Accepted (extends ADR-0013)
- **Date**: 2026-11-01
- **Requirements**: EVT-07, EVT-08, EVT-09, LIM-01, §4 Privacy and Reliability

## Context

Event data must be deleted 1 year after the event's last function, with reminders and a full export
first (EVT-07/08). Hosts can delete earlier, and a single family can ask to be erased (EVT-09).
Since M7, files live in object storage (ADR-0030), which database cascades can't reach. Only
anonymised counts may be kept.

## Options considered

- **Delete files inline with the database rows**: simple, but a crash or a store outage between the
  two leaves files nobody can find again.
- **Queue file deletions in the same transaction as the row deletes** and let a job retry them.

## Decision

- **Deletion date**: the last function's date + 1 year (29 Feb → 1 Mar), else the event's end date;
  with neither, the event is never deleted automatically and the App Admin list flags it. Dates
  are compared with "today" in the event's timezone, so deletion happens on that local day.
- **Banner**: once the last function's day is over, every event page shows the deletion date with
  a link to the archive (Settings → Data and deletion).
- **Reminders** (`retention_notices`): Hosts get an in-app notification and an email 60, 30 and 7
  days before; vendor contacts are told to download their invoices and payment records. Each
  threshold is claimed with an insert, so it goes out once; when the job runs late only the nearest
  threshold is sent. If the deletion date moves, the notices reset. Email keys are
  `retention:<eventId>:<days>:<recipient>`.
- **Purge** (daily cron, `// [M7 retention jobs]`): under a row lock, re-check the date, write
  `event_metrics` (counts only, no names, no event id, no FK), queue `storage_deletions` for
  `events/<id>/`, write a platform audit row, then `DELETE FROM events` (everything cascades). The
  soft-delete purge (`purgeDeletedEvents`, ADR-0013) goes through the same function.
- **Storage GC**: `storage_deletions` has no event FK, so rows outlive the event; the daily job
  deletes each prefix with backoff (5 min … 1 day) and a lease so runs don't collide. Household
  deletion queues `events/<eid>/households/<hid>/`.
- **Archive** (`event.export`: Hosts and App Admins, step-up OTP, audited): streamed ZIPs built
  with fflate, one per *part*. Part `main` holds Excel files (guests, RSVPs/headcount, budget,
  payments, payables, vendors without bank/PAN, gifts and thank-yous), printable HTML (run sheets,
  invoices, ADR-0015) and every document. Other modules register parts (`registerArchivePart`);
  the gallery adds `gallery-*` parts of under ~2 GB each, because fflate writes classic ZIPs (no
  Zip64) and a function has 300 s.
- **Erasure requests** (`guest_erasure_requests`): recorded from the family's page with the date
  asked; "Erase now" deletes the household (gifts stay, anonymised) and marks the request done. The
  log keeps only the family's name and dates, as evidence the request was honoured.

## Consequences

- A slow or failing store never blocks a purge; files go within a day or two, and well within the
  35-day backup window.
- Usage counters can drift when rows go by cascade; the daily reconcile fixes them.
- On the Hobby plan the cron is daily, so reminders and purges happen at most a day late.
- The archive is generated on demand; a very large `main` part (thousands of documents) could near
  the 300 s limit, in which case documents should move to their own parts.
