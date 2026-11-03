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
  the gallery adds `gallery-*` parts of up to 400 MB / 500 files each (ADR-0031 amendment; the
  archive download limit counts per part), because fflate writes classic ZIPs (no
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

## Amendments (M7 review, 2026-11-01)

- **No deletion without notice**: the purge only deletes an event when a `retention_notices` row
  for the *current* deletion date was sent at least 7 days earlier (event-timezone days). If none
  exists (the job was down, the date moved late, the event was already past its date), the purge
  sends the 7-day notice itself (Hosts in-app + email, vendors) and the effective deletion date
  becomes notice + 7 days. The banner and settings show that effective date.
- **Reminder email keys** include the deletion date (`retention:<eventId>:<deletionDate>:<days>:<recipient>`),
  so reminders restarted by a moved date are emailed again instead of being deduplicated away.
- **Events without dates**: the fallback clock is the creation day (event timezone) + 2 years,
  with the same 60/30/7-day reminders and the same "no deletion without notice" rule. The banner
  starts a year before. The App Admin list still flags these events. Rationale: "never" kept
  personal data indefinitely for abandoned drafts, contrary to EVT-07 and DPDP purpose limitation;
  2 years is generous for an event that was never dated.
- **Erasure (DPDP right to erasure)**: processing is one transaction that, besides deleting the
  household (and queuing `events/<eid>/households/<hid>/`):
  - deletes documents attached to the family's gifts (item photos), freeing quota and queuing the
    objects for deletion;
  - deletes queued `outbound_messages` to the family and blanks `to_address`, `vars` and `guest_id`
    on sent ones (the delivery status and counts stay);
  - sets `data` to null on `audit_logs` rows whose `entity_id` is the household, one of its members
    or one of the deleted gift documents, and drops the `name` key from their gifts' log rows.
    The rows themselves (who did what, when) stay. This is a deliberate exception to the
    "immutable audit log" rule: the law requires the personal data to go, not the evidence;
  - replaces `guest_erasure_requests.household_name` with a neutral label
    (`Erased family #<first 8 of the request id>`, shown translated) and drops the note.
  Erasing needs a fresh OTP (`requireStepUp`, EVT-01d); the request is recorded first so it isn't
  lost if the user abandons the OTP step, and the button uses `ConfirmButton`.
- **Archive**: unreadable files are retried once and otherwise listed in `MISSING.txt` (localised
  name) at the end of the ZIP; a cancelled download stops reading immediately. Downloads are
  limited to 10 per event per day (`allowAttempt`), with a friendly message on the settings page.
- **Daily cron budget** (`/api/cron/daily`, 60 s): time-critical jobs run first (caterer headcount
  locks and alerts, reminders, the outbox), then retention and storage housekeeping with the
  remaining budget (purge, expired upload reservations, storage deletions, reconcile with a time
  budget), then a final outbox drain for notices the purge queued. Jobs that no longer fit are
  skipped until tomorrow; each job is isolated (`src/lib/cron.ts`).
- **Stuck storage deletions** (5+ failed attempts) are counted on the App Admin pages.
