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

## Amendments (gallery review, 2026-11-01)

- **Reservation ids without a foreign key**: `media_items.reservation_id` keeps the id after the
  daily job gives an expired reservation back (the FK used to null it, and commit/release then
  fell back to "oldest reservation of the same size", stealing another upload's). commit/release
  look the id up; gone (or `null` on old rows) means "already given back": commit counts the
  object as new usage (event and family counters), release does nothing.
- **Content is verified, not declared** (security S1): `complete` reads the first 64 bytes from
  the store and checks the magic number (JPEG, PNG, RIFF/WEBP, `ftyp` HEIC/HEIF/MP4/QuickTime,
  WebM EBML) against the declared type (HEIC≈HEIF, MP4≈MOV). A mismatch deletes the object and
  gives the reservation back. The stored `mime` is the verified type, and file extensions in
  downloads and ZIPs come from it, never from the uploader's file name.
- **Lost "complete"**: a retried `begin` for an item still `uploading` first `head()`s the key; if
  the object is there it finishes the upload and answers `done` (grants never overwrite, so the
  retry would otherwise fail for ever).
- **Family erasure** (EVT-09) gives the family's stored bytes and in-flight reservations back in
  the same transaction, instead of waiting for the nightly reconcile.
- **Orphan sweep** runs in 32 steps per event (`gallery/<hex>` then `households/<hex>`), checks
  ids against the database in chunks of 500, saves the step reached and stops at its time budget
  (events part-way through go first), so it never holds up later cron jobs.
- **ZIPs within one function's 300 s**: parts are at most **400 MB or 500 files** (about 1.5 MB/s
  is enough; the old 2 GB parts couldn't stream in time). Because there are more parts, limits
  count **parts when they start**: the family's full download allows each part 5 times per event
  per day (§4.1 "5 full downloads"), so restarting at part 2 or parallel parts don't escape it; the
  EVT-08 archive counts per part as well. Guests' function ZIPs count every part per family (10 a
  day) and per event and part (5 a day, the same cap as full downloads). ZIP paths use the capture
  day in the event's timezone.
- **Guests' ZIPs** contain other families' photos without metadata (stripped JPEG or the clean
  JPEG copy, ADR-0032) under id-based names, leave out photos whose preview failed, and aren't
  offered at all while a watermark is set.
