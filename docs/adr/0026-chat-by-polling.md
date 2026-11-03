# ADR-0026: In-app chat by short polling

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: MSG-01

## Context

Chat needs near-real-time delivery for a team channel, function threads and vendor threads. We run
on Vercel functions with no WebSocket service or Pusher/Ably account.

## Options considered

- **WebSockets / hosted realtime (Pusher, Ably)**: instant, but a new provider and account.
- **Server-sent events**: long-lived functions, costly on serverless.
- **Short polling every 5 s while the tab is visible**: a few cheap queries, no new infrastructure.

## Decision

Messages carry a per-thread `seq` (posting locks the thread row so sequence numbers commit in
order). Clients poll `GET …/api?after=<seq>` every 5 s only while visible. Read state updates only
on requests with an `X-EH-Poll` header (not sendable cross-site without preflight) or on opening the
thread. Unread notifications are collapsed to one per thread.

## Consequences

Up to ~5 s latency, which is fine for planning chat. Swap in a realtime provider later behind the
same API if live day-of chat needs it.
