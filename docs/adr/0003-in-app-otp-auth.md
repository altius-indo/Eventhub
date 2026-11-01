# ADR-0003: Passwordless OTP auth built in-app

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

Requirements: passwordless login by phone (SMS/WhatsApp) or email OTP, one account with several identifiers, 30-day sliding sessions, device list, step-up re-verification (EVT-01..01d). Auth.js v5 is in beta and has no first-class phone OTP; managed services add cost and a vendor dependency for a simple flow.

## Options considered

- Auth.js with a custom credentials/email provider.
- A managed auth service (e.g. phone OTP SaaS).
- Our own small implementation on Postgres.

## Decision

Implement OTP and sessions ourselves (`src/lib/otp.ts`, `src/lib/auth-core.ts`): 6-digit codes stored as HMAC, 5-minute expiry, 5 attempts, 30 s resend cooldown, per-identifier and per-IP limits; random session tokens stored as SHA-256 in `sessions`, http-only cookie, sliding 30 days; `stepUpAt` with a 10-minute window (a fresh login counts). Delivery goes through pluggable providers (ADR-0012).

## Consequences

Full control and small surface; every rule is unit-tested. We own security maintenance for this code, so changes to it require the `security-reviewer` agent. Revisit if we need SSO or social login.
