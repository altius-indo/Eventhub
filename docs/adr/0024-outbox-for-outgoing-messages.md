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
