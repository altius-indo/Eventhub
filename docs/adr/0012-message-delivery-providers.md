# ADR-0012: Pluggable message delivery with a dev outbox

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

OTP codes, invitations, guest links and reminders go by email, SMS and WhatsApp. Indian SMS needs DLT-registered templates and WhatsApp needs Business API approval, which take weeks.

## Options considered

- Wait for providers before building flows.
- Provider interface with a development outbox.

## Decision

`src/lib/delivery` chooses a provider per channel from env (`EMAIL_PROVIDER=dev|smtp`, `PHONE_PROVIDER=dev|disabled`). The dev provider writes to `dev_outbox` (viewable at `/dev/outbox`) and refuses to run in production unless `ALLOW_DEV_DELIVERY=1`. Delivery failures don't roll back the business action.

## Consequences

Everything is testable end to end now. SMS (DLT) and WhatsApp BSP providers will be added behind the same interface; email OTP works in production from day one.
