# ADR-0006: Signed guest links instead of stored tokens

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

Each family needs a personal link without login (GST-06) that can be regenerated or turned off, and resolved quickly at scale.

## Options considered

- Random token stored in the database (plaintext or hashed).
- JWT with expiry.
- Household id + HMAC(id, linkVersion).

## Decision

Token = base64url(household id) + truncated HMAC over (id, `link_version`). Regenerating bumps `link_version`; turning off sets `link_revoked_at`. `/g/<token>` sets a per-event http-only cookie and redirects to the wedding site, which renders the family's personal view.

## Consequences

No secret stored; links can be shown to planners any time. Rotating `AUTH_SECRET` invalidates every guest link, which must be communicated if it ever happens.
