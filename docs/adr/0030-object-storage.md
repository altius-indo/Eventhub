# ADR-0030: Object storage: private Vercel Blob in production, filesystem in development

- **Status**: Accepted (supersedes ADR-0018 for new documents)
- **Date**: 2026-11-01
- **Requirements**: §4 Files, §4.1 storage limits, LIM-01, LIM-03, GAL-02, GAL-03, EVT-07, EVT-09, VND-09

## Context

Milestone 7 brings the photo gallery: 5,000–20,000 photos and videos up to 4 GB per wedding.
Documents (ADR-0018) and site images (ADR-0009) were kept in Postgres as a stop-gap. Vercel
functions refuse request bodies over ~4.5 MB (ADR-0021), so large files must go from the browser
straight to storage. Data should stay in India where possible, and everything for an event must be
deletable in one go (EVT-07).

## Options considered

- **S3 / R2 with presigned URLs**: mature, has lifecycle tiering; another vendor account, IAM and
  CDN to operate.
- **Vercel Blob, private store**: already part of the hosting account, region `bom1` (Mumbai),
  client uploads with multipart, presigned GET URLs, no public URLs for private stores.
- **Keep bytes in Postgres**: fine for MBs, not for hundreds of GB.

## Decision

- **Interface**: `src/lib/storage` exposes one `ObjectStore` (`put`, `get`, `getBytes`, `head`,
  `delete`, `deleteByPrefix`, `list`, `presignedGet`, `authorizeUpload`). Keys are always chosen by
  the server and validated: `events/<eventId>/...`, with `events/<eid>/households/<hid>/` for
  anything a family uploads (erasure is one prefix delete) and `events/<eid>/documents/<id>`.
- **Production**: a private Vercel Blob store (`eventhub-media`, region **bom1 / Mumbai**),
  connected to Production and Preview. Credentials come from `BLOB_READ_WRITE_TOKEN`, which Vercel
  injects. `STORAGE_DRIVER` defaults to `blob` when that token is set, otherwise `fs`.
- **Development and tests**: files under `STORAGE_FS_ROOT` (default `.data/blobs`, gitignored).
  Temporary URLs point at `/api/dev-blob/<key>` and carry an HMAC (AUTH_SECRET) over the operation,
  key, expiry and, for uploads, the size limit and allowed types. The route only works with the
  filesystem driver, and refuses to run on Vercel (ephemeral disk).
- **Direct uploads**: `authorizeUpload({ key, maxBytes, contentTypes })` returns an `UploadGrant`:
  a Blob client token bound to that exact pathname, size and types (no overwrite), or a signed dev
  `PUT` URL. The browser uploads with `uploadWithGrant()` (multipart for big files on Blob). We
  issue tokens with `generateClientTokenFromReadWriteToken` rather than `handleUpload`, because
  `handleUpload` lets the client propose the pathname; here the server picks it. After the upload
  the server `head()`s the key to confirm the real size before committing quota.
- **Reads**: our routes check permissions and either stream the bytes (documents, ≤ 20 MB) or
  redirect to a short-lived `presignedGet` URL (gallery renditions, videos).
- **Documents**: new uploads go to the store (`documents.storage_key`); rows without a key still
  read from `document_blobs`. `scripts/migrate-documents-to-store.ts` moves old rows.
- **Quota** (§4.1): `storage-quota.ts` reserves bytes under a row lock before an upload and commits
  the real size after it; members and guests stop at 100% of the event limit, vendors may use a
  10% reserve; per-household caps for guests; Hosts are warned once at 80% and 95%. A daily job
  reconciles the counter with the database (cascaded deletes don't pass through our code) and
  removes document objects no row points to.

## Consequences

- Uploads beyond 4.5 MB work on Vercel once callers use upload grants (the gallery does; documents
  still post through the function and keep the 4 MB Vercel cap for now).
- **Deferred**: §4.1 asks for originals to move to an infrequent-access tier after 90 days. Blob
  has no storage classes or lifecycle rules, so there's no tiering; revisit (e.g. R2/S3 for
  originals) if storage cost matters at scale.
- Blob's private store has no per-object ACLs, so every read must go through our permission checks;
  presigned URLs should stay short (minutes).
- Website images (ADR-0009) are still in Postgres; moving them is follow-up work.
- Backups: Blob isn't covered by the database's point-in-time recovery; deletions are immediate,
  which satisfies the 35-day purge (EVT-09) but means accidental deletes can't be undone from backup.

## Amendments (M7 review, 2026-11-01)

- **Reservations are rows** (`storage_reservations`, event cascade) with an expiry (default 7 h,
  longer than the longest upload grant). `reserve()` returns `{ id, bytes, expiresAt }`; pass the id
  to `commit`/`release` as `reservationId` (optional for older callers: the oldest reservation of the
  same size and family is used). Expired reservations are given back by the daily job and before
  each new reservation for that event; `reconcileUsage` recomputes `reserved_bytes` from live rows,
  so an abandoned browser upload never holds quota for ever.
- **Usage sources are registered in one module** (`src/lib/storage-sources.ts`, imported by
  `storage-quota.ts`), so reconcile always sees every source and can't reset usage to documents only.
  The gallery adds its sources there (`// [M7 gallery usage source]`).
- **Production driver**: with `NODE_ENV=production` and no `BLOB_READ_WRITE_TOKEN`, the filesystem
  driver must be chosen explicitly (`STORAGE_DRIVER=fs`), otherwise `getStore()` throws
  `not_configured`; the dev-blob route answers 404 unless the fs driver is active and configured.
