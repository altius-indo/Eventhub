# ADR-0004: One policy function for all permissions

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

The roles were simplified to App Admin, Host and Planner (plus vendors and guests). Permission rules from the requirements matrix (§2.1) must be applied consistently across dozens of pages and actions, including "allowed but needs Host approval".

## Options considered

- Role checks inline in each page/action.
- A policy library (CASL etc.).
- One small typed `decide(subject, permission)` returning `allow | approval | deny`.

## Decision

`src/lib/policy.ts` lists every permission and maps roles to decisions. Pages and actions use `ctx.can()` / `ctx.decide()` from `getEventContext`; non-members get 404. App Admins are allowed everything and their access is audited.

## Consequences

Permissions are reviewable in one file and exhaustively tested per role. New modules add permission names rather than ad-hoc checks. Field-level rules (e.g. gift access) live there too.
