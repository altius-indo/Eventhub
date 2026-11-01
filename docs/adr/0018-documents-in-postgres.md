# ADR-0018: Documents in Postgres behind a small module (interim)

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: VND-09, PAY-01, PAY-03, §4 Files

## Context

Contracts, quotes, invoices and receipts are PDFs or photos up to 20 MB. Object storage arrives with the photo gallery in M7 (ADR-0009 made the same call for website images).

## Decision

- **Storage**: files go in `documents` (metadata, owner, sha256) and `document_blobs` (bytes). The bytes live in a separate table so listing documents never loads them. All access is through `src/lib/documents.ts`.
- **Upload**: a plain multipart form posts to the route handler `/events/<id>/documents`, because server actions are capped at 6 MB. The handler checks the request is same-origin and returns to a same-event page.
  - `experimental.proxyClientMaxBodySize` is raised to 21 MB so the proxy doesn't truncate bodies.
- **Validation**: types are sniffed from the bytes (PDF, JPEG, PNG, WebP, HEIC); the browser's content type isn't trusted. Filenames are sanitised. Each event has a 500 MB cap, serialised with an advisory lock.
- **Download**: only for event members, as an attachment, with `private, no-store`, `nosniff` and a sandboxing CSP.

## Consequences

Documents are deleted with the event (cascade, EVT-07). Backups grow with documents. Move to object storage behind the same module in M7.
