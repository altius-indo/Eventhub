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

## Amendments (gallery review, 2026-11-01)

- **Memory**: sharp runs with `concurrency(1)`, `cache(false)` and `limitInputPixels` 100 MP. A
  worker takes one item at a time and decodes each photo once at full size: the web copy comes
  from the original, the thumbnail from the (small) web copy, sequentially.
- **Where renditions are made**: upload requests no longer decode photos. `renditionsSoon()` kicks
  the self-chaining drain route once per request, deduplicated per server instance (a kick while
  one is in flight just asks for one more round afterwards). Without `CRON_SECRET` (development)
  the same kick processes in-process.
- **Retries**: a temporary failure (storage read, unexpected error) sets `locked_until` to a
  backoff of 30 s, then 60 s (3 attempts, then `failed`). The drain returns when the next retry
  is due and, if that's within 2 minutes, waits and calls itself again (as the outbox drain does),
  so a hiccup doesn't wait for the daily cron.
- **HEIC/HEIF** (§4 "HEIC converted for browsers"): the prebuilt sharp has libheif without an HEVC
  decoder, so iPhone photos are decoded with `heic-decode` (libheif + libde265 in WebAssembly, no
  native build; listed in `serverExternalPackages`). The pixel count is checked before decoding.
  Tested with an 885-byte HEIC fixture (`tests/fixtures/tiny.heic`).
- **Guests never get metadata from someone else's file** (security S2): JPEG originals are served
  to guests (single downloads and ZIPs, when the family allows originals) with a lossless rewrite
  that keeps the image data, JFIF, ICC and Adobe segments plus a new EXIF block with only the
  orientation and capture time; GPS, camera serials, maker notes, XMP, IPTC, comments and MPF extra
  images go. Other photo types (HEIC, PNG, WebP) get a clean full-size JPEG (`share.jpg`, quality
  92, capture time kept) made with the renditions and not counted against quota. The family and
  Hosts, the uploading family, and the photographer (selections) keep true originals.
  **Not covered**: videos are served as uploaded (MP4/MOV location atoms stay); stripping them
  needs a remux, deferred with transcoding.
- **Watermark** (GAL-10, security S4): when set, guests' web view *and* download are the
  watermarked copy (`web-wm-<hash>.jpg`, made once per watermark text and cached next to the
  renditions), and guest originals/ZIPs are off. Changing the text makes new copies lazily.
- **Previews that fail** never make a guest upload visible on their own: such items wait for
  moderation even with auto-approve on, and guests get no file for them.
- **"Photos are ready"** (GAL-11) is sent once per function, tracked in `gallery_ready_notices`:
  on release, or when renditions finish for an album released earlier. If the messaging limit
  refuses it, the state is `quota` and the album page offers Hosts/Planners "Send now".
- **Website highlights** (GAL-05, security S5) must be approved photos in a released album of a
  public function, checked when picking and on every read; withdrawing the album, hiding the
  photo, a granted removal or making the function private clears them. Picking is audited, and
  the public image route caches for at most 5 minutes (`s-maxage=300`).
