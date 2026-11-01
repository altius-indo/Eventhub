# ADR-0031: Gallery uploads go straight to storage, with quota reserved first

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: GAL-01..06, §4.1 gallery storage limits, LIM-01, LIM-03, EVT-07, EVT-09

## Context

A wedding gallery is 5,000–20,000 photos plus videos up to 4 GB, uploaded by the photographer
(vendor portal), the family (app) and guests (wedding site via their link). Vercel functions refuse
bodies over ~4.5 MB (ADR-0021), so bytes can't pass through our server. Quota (§4.1) must hold
under concurrent uploads, guests are capped per family (300 items / 5 GB), vendors may use a 10%
reserve, and an abandoned upload must not hold space for ever. ADR-0030 provides the store,
upload grants and the reservation-based quota.

## Options considered

- **Upload through a route handler in chunks**: works on Vercel, but every byte crosses a function
  (time and bandwidth cost), and resumability is ours to build.
- **Direct upload with a grant, then confirm** (chosen): the browser sends the file straight to Blob
  (multipart for big files) or, in development, to the signed `/api/dev-blob` URL.
- **Let the client choose the key (`handleUpload`)**: simpler SDK flow, but the client could write
  outside its area.

## Decision

- **Three thin endpoints, one domain flow** (`src/lib/gallery.ts`): members
  `events/[eventId]/gallery/upload`, vendors `vendor/[vendorId]/gallery/upload`, guests
  `[slug]/gallery/upload` (guest-link cookie only). Each takes `begin`, `complete` or `abort`.
- **begin**: validates the type (photos JPEG/PNG/WebP/HEIC; videos MP4/MOV/WebM; guests' photos
  JPEG only, resized in the browser to ≤ 4096 px) and size (photo 50 MB; video 4 GB for vendors and
  the family, 500 MB for guests), and the uploader's right: vendors only into their own, unreleased
  delivery album of a function they have a confirmed Photography/Videography booking for; guests
  only when guest uploads are on, only for functions their family is invited to, rate-limited
  (`allowAttempt`, 300/hour per family). Then `reserve()` (row-locked; vendors get the 10% reserve,
  guests the per-family cap) with a TTL of the grant plus an hour, a `media_items` row in
  `uploading`, and a grant for exactly that key, declared size and type. The browser picks a
  `client_key` per file (unique per event), so a retried `begin` resumes the same item instead of
  reserving twice.
- **Keys** are server-chosen: `events/<eid>/gallery/<mediaId>/original` for members and vendors,
  `events/<eid>/households/<hid>/gallery/<mediaId>/original` for guests, so a family's erasure is the
  household prefix delete (EVT-09). Renditions sit next to the original.
- **complete**: `head()` the key. Missing → "try again"; bigger than declared or empty → delete the
  object and release; otherwise `commit()` the real size (with the reservation id) and move the item
  to `processing` for renditions (ADR-0032).
- **Abandoned uploads**: the daily job finishes items whose object did arrive (if the reservation
  had already expired, the object counts as new usage) and deletes rows whose object never came;
  expired reservations themselves are released by the storage job (ADR-0030).
- **Usage**: sources `gallery.member|vendor|guest` in `storage-sources.ts` sum stored originals.
  Renditions (two WebP files, a few % of the original) aren't counted.
- **Orphans**: rows that disappear by cascade (a function or vendor deleted) leave objects behind;
  a daily sweep deletes gallery objects older than a day that no row points at.
- **Reads** go through our routes, which check `canViewMedia` and redirect to a 5-minute presigned
  URL; downloads stream with an attachment header. ZIPs (family albums, "everything" in ~2 GB parts,
  5 full downloads per event per day; guests per function only when originals are allowed) stream
  with fflate (`zipStream`).

## Consequences

- Uploads of any size work on Vercel; our functions only sign and confirm.
- Guests' resized photos lose their EXIF capture time when the browser had to re-encode them
  (larger than 4096 px or not JPEG); they're sorted by upload time instead.
- The guest 10-minute video limit is checked in the browser only (no server-side probing).
- No tiering of originals after 90 days (Blob has no storage classes; see ADR-0030).
- A venue QR opens the site gallery; uploading needs the family's guest link on that phone, so
  there are no anonymous uploads.
