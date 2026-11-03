# ADR-0001: Record architecture decisions

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

The project is built over several milestones, partly by AI agents working in separate sessions. Decisions made in chat get lost, and later work re-litigates or silently contradicts them.

## Options considered

- Keep decisions in chat and commit messages only.
- A single long design document.
- Short numbered ADRs, one per decision (Michael Nygard format).

## Decision

Record each significant technical decision as a numbered ADR in `docs/adr/` using `template.md`, indexed in `README.md`. Agents create them with the `adr` skill. ADRs are never deleted; a reversed decision is marked *Superseded*.

## Consequences

Anyone (human or agent) can find why things are the way they are. Small overhead per decision. `CLAUDE.md` points here, so agents read relevant ADRs before changing an area.
