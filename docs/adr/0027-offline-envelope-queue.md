# ADR-0027: Offline envelope entry with client keys

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: GFT-02, GFT-03

## Context

Shagun is collected at venues with poor connectivity. Entries must not be lost or duplicated when a
phone retries or two collectors' devices sync the same queue.

## Options considered

- **Online-only form**: loses entries when the network drops.
- **Client-generated UUID per entry, queued in the browser, inserted with ON CONFLICT DO NOTHING**:
  same pattern as offline check-in.

## Decision

The envelope desk keeps a local queue (localStorage) of entries, each with a `clientKey` UUID, and
syncs in batches. `recordEnvelopes` inserts with `on conflict (event_id, client_key) do nothing`, validates each
entry on its own (a bad entry doesn't drop the batch) and warns on a repeated envelope number in the
same function. Cash hand-over locks the collector's open cash gifts and stamps them; entries that sync
later stay open for the next hand-over.

## Consequences

Retries are safe. Data on a phone that never reconnects is lost; the desk shows the pending count so
collectors know to sync before leaving.
