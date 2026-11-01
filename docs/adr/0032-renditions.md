# ADR-0032: Gallery renditions made by an in-app worker with sharp

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: GAL-01, GAL-04, GAL-06, GAL-10, NFR Files (thumbnails and web renditions)

## Context

Guests browse on phones over venue Wi-Fi; originals are 5–50 MB. Every photo needs a small
thumbnail and a web-size copy, rotated by EXIF and sorted by capture time. We run on Vercel without
a separate queue (ADR-0024) and already ship sharp.

## Options considered

- **Image CDN / on-the-fly resizing**: no stored renditions, but private Blob objects can't be
  handed to an image optimiser without making them fetchable, and cost scales with views.
- **Managed media service** (also for video transcoding): best quality, another vendor and account.
- **Our own worker with sharp, outbox-style** (chosen).

## Decision

- After `complete`, an item is `processing`. `processRenditions` claims up to two items at a time
  with `FOR UPDATE SKIP LOCKED` and a 5-minute lease, so the after-response hook, the
  self-chaining `/api/gallery/renditions/drain` (Bearer `CRON_SECRET`) and the daily cron never
  process the same item twice.
- Per photo: auto-rotate, a 480 px WebP thumbnail and a 2048 px WebP web copy, width/height, and
  the EXIF capture time (DateTimeOriginal, with OffsetTimeOriginal when present, else read as
  wall-clock time in the event's timezone) — parsed by a small reader, no extra dependency.
- Then the item becomes visible: guest uploads `pending` (or `approved` with auto-approve, GAL-04),
  family and vendor uploads `approved`.
- A photo sharp can't decode (some HEIC) keeps `preview_error`: placeholder thumbnail, original
  still downloadable. Storage errors are retried up to 3 times, then `failed`.
- Videos are not transcoded: placeholder thumbnail; the browser streams the original.
- The guest download copy is watermarked on the fly (GAL-10) from the web copy; nothing extra is
  stored, so changing the watermark applies at once.

## Consequences

- No new infrastructure. Throughput is roughly 1–2 photos/second per running drain, so a 2,000-photo
  delivery takes some minutes; the drain chains itself. On the Hobby plan without `CRON_SECRET` set,
  items not processed right after their upload wait for the daily cron.
- HEIC support depends on the sharp build (libheif); HEVC-only files get no preview.
- Videos have no poster frame and play at full bitrate; revisit with a transcoding service if
  guests struggle to stream.
