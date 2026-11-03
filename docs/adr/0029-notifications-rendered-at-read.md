# ADR-0029: Notifications stored as kind + data, rendered when read

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: MSG-05

## Context

Notifications go to people who read in English or Hindi, and the text may change. Emails for some
categories should be sent according to user preferences.

## Options considered

- **Store rendered text**: simple, but fixed to one language and wording.
- **Store `kind` and data; render with `notifications.kinds.<kind>` at read time**.

## Decision

`notifications` rows hold a kind, small data values and an href. The bell and centre render them in
the reader's language. Email copies go through the outbox per category preference (mentions,
approvals, payments, headcount, usage and vendors on by default). Rows older than 90 days are purged
by the daily job.

## Consequences

Adding a notification kind needs en/hi strings (enforced by the parity test). Data values are
rendered as text by React, never as HTML.
