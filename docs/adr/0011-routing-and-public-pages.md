# ADR-0011: App areas protected by prefix; wedding sites at the root

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

The wedding website lives at `/<couple-slug>` (WEB-01), next to app routes such as `/events`. The proxy can't know which slugs exist.

## Options considered

- Sites under a prefix such as `/w/<slug>`.
- Root slugs with a protected-prefix list and reserved slugs.

## Decision

`src/proxy.ts` redirects signed-out visitors only for `PROTECTED_PREFIXES`; everything else is public, and each page enforces its own access. `RESERVED_SLUGS` in `src/lib/website.ts` keeps app paths out of the slug space.

## Consequences

Short, shareable website addresses. Every new top-level app route must be added to both lists (rule in `.claude/rules/nextjs.md`).
