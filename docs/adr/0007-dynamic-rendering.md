# ADR-0007: Dynamic rendering; Cache Components off

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

Next.js 16 scaffolds with `cacheComponents: true`, which requires reading cookies inside Suspense boundaries or `use cache: private`. Nearly every EventHub page is per-user and per-event.

## Options considered

- Adopt Cache Components with Suspense boundaries everywhere.
- Turn it off and render dynamically.

## Decision

Set `cacheComponents: false`. Pages that read the session are dynamic; mutations call `revalidatePath`.

## Consequences

Simpler mental model and code. Slightly slower first byte on some pages, acceptable at our scale. Revisit for the public wedding website if traffic warrants static shells.
