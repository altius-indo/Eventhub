# ADR-0024: Outbox table for outgoing messages

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: MSG-02, MSG-03, MSG-04, RSV-03, NFR Reliability

## Context

Broadcasts, reminders, invites, notifications and thank-you notes all send email/SMS/WhatsApp.
Sends must survive provider errors, not double-send on retries, fall back between channels and run
on Vercel without a separate queue service.

## Options considered

- **Redis/BullMQ or pg-boss**: proper queues, but another service (BullMQ) or library to operate.
- **Send inline in server actions**: simplest, but a 1,000-guest broadcast exceeds request limits and
  failures are lost.
- **`outbound_messages` table drained by the app**: transactional with the business write, no new
  infrastructure.

## Decision

Messages are inserted into `outbound_messages` in the same transaction as the change that causes
them, with an idempotency `key` (unique). A drainer claims rows with `FOR UPDATE SKIP LOCKED`, renders
the registered template at send time (so guest links aren't stored), and retries with backoff
1m/5m/30m/2h, up to 4 attempts; on a permanent channel failure it falls back to the next channel
(WhatsApp → email → SMS, or the household's preference). Drains run after the response (`drainSoon`),
from `/api/outbox/drain` (Bearer `CRON_SECRET`, chains itself while rows remain) and the daily cron.
`src/lib/templates.ts` loads every template module so any drainer can render any row.

## Consequences

No extra service to run. On the Hobby plan the cron is daily, so anything not drained right after
the request waits until then; Pro (or an external pinger) is recommended before a real wedding.

## Retries (addendum)

- `processOutbox` returns `remaining` (rows due now) and `nextDueAt` (the earliest queued retry or
  stale claim). `nextDrainDelay()` turns that into "drain again now", "drain again in N ms" (when
  due within `RETRY_WINDOW_MS`, 2 minutes) or "leave it to the daily cron".
- `drainSoon` hands over to `/api/outbox/drain` in either of the first two cases; the drain route
  waits in `after()` with `setTimeout` (capped at 50 s so it fits `maxDuration = 60`) and calls
  itself, so the 1-minute first retry goes out within about a minute instead of the next day.
  Longer backoffs (5m, 30m, 2h) still wait for the next drain or the cron.
- A send that throws something other than a `DeliveryError` (e.g. a template bug) is handled in a
  separate transaction: it is re-queued with the same backoff and, after `MAX_ATTEMPTS`, marked
  `failed` with its quota reservation released, so no row stays in `sending` for ever.
- A fallback to the next channel keeps the original row's `bulk` flag, so it counts against the
  bulk limit (LIM-03). If that channel is over its limit, the row is marked `failed` with
  `error_code = quota:<channel>` instead of throwing.
