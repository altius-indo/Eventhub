# ADR-0009: Wedding-website images stored in Postgres (interim)

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

The website needs a cover photo, story photos and a small gallery (WEB-02/07). Object storage and a CDN arrive with the photo gallery (milestone 7).

## Options considered

- Introduce S3-compatible storage now.
- Store resized images in Postgres (`bytea`) for now.

## Decision

Uploads are re-encoded with sharp (rotate, max 1800px, WebP q80) and stored in `site_images`; served by `/site-images/<id>` with public immutable caching only when used by a published, non-passcode site. At most 30 images per section, and unused images are pruned.

## Consequences

No new infrastructure yet; images are deleted with the event (retention). Postgres size grows by a few MB per event. **To be superseded** when object storage lands in milestone 7; migrate rows to the bucket then.
