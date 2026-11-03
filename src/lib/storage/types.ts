/**
 * Object storage abstraction (ADR-0030). Production uses a private Vercel Blob store; development
 * and tests use the filesystem with HMAC-signed short-lived URLs served by `/api/dev-blob/...`.
 *
 * Keys are always chosen by the server and always start with `events/<eventId>/` (see `keys.ts`),
 * so deleting an event's data is one prefix delete. Never build a key from user input without
 * going through the helpers in `keys.ts`.
 */

export type StorageDriver = "blob" | "fs";

/** Metadata of a stored object. `mime` may be null when the driver can't tell (listings). */
export type ObjectInfo = { key: string; size: number; mime: string | null; uploadedAt: Date };

export type GetResult = { stream: ReadableStream<Uint8Array>; size: number | null; mime: string };

/**
 * Permission for a browser to upload **one** object directly to the store, bypassing our
 * functions (which refuse bodies over ~4.5 MB on Vercel). Issue it from a server action/route
 * after checking permissions and reserving quota, hand it to the client as JSON, and upload with
 * `uploadWithGrant()` from `@/lib/storage/client-upload`.
 *
 * - `driver: "blob"`: `token` is a Vercel Blob client token bound to exactly `key`, `maxBytes`
 *   and `contentTypes`, valid until `expiresAt`. The client calls `put(key, file, { access:
 *   "private", token, multipart })` from `@vercel/blob/client` (multipart for big files).
 * - `driver: "fs"`: `url` is a signed same-origin `PUT` URL (`/api/dev-blob/<key>?...`).
 *
 * The grant never overwrites an existing object. The upload itself proves nothing: after the
 * client reports success, the server must `head(key)` to confirm the object exists and check its
 * real size (and sniff the type if it matters) before committing quota and creating rows.
 */
export type UploadGrant = {
  driver: StorageDriver;
  key: string;
  maxBytes: number;
  contentTypes: string[];
  expiresAt: string;
  /** Use multipart (chunked, resumable per part) uploads; only meaningful for `blob`. */
  multipart: boolean;
  /** `blob` only: client token for `@vercel/blob/client` `put`. */
  token?: string;
  /** `fs` only: signed URL for a single `PUT` with the raw bytes as the body. */
  url?: string;
};

export type UploadRequest = {
  /** Server-chosen key (use `keys.ts`). */
  key: string;
  /** Hard upper bound enforced by the store (and by quota reservation on our side). */
  maxBytes: number;
  /** Allowed content types, e.g. ["image/jpeg", "image/heic", "video/*"]. */
  contentTypes: string[];
  /** Default 15 minutes; at most 6 hours (large videos over slow links). */
  ttlSeconds?: number;
  multipart?: boolean;
};

export interface ObjectStore {
  readonly driver: StorageDriver;
  /** Stores bytes at `key` (overwrites). For files our server already holds (≤ request limits). */
  put(key: string, data: Uint8Array, mime: string): Promise<{ key: string; size: number }>;
  /** Streams an object, or null when missing. */
  get(key: string): Promise<GetResult | null>;
  /** Reads a whole object into memory (only for small objects such as documents). */
  getBytes(key: string): Promise<Buffer | null>;
  head(key: string): Promise<ObjectInfo | null>;
  /** Deletes one object; missing objects are fine. */
  delete(key: string): Promise<void>;
  /** Deletes every object under a prefix (must be `events/<uuid>/...`); returns how many. */
  deleteByPrefix(prefix: string): Promise<number>;
  /** Lists objects under a prefix (paginated internally). */
  list(prefix: string): AsyncIterable<ObjectInfo>;
  /**
   * A temporary URL anyone holding it can `GET` (default 5 minutes). Only hand it to a user who
   * passed the permission check for that object; prefer short TTLs.
   */
  presignedGet(key: string, opts?: { ttlSeconds?: number }): Promise<string>;
  /** Authorises one direct browser upload; see {@link UploadGrant}. */
  authorizeUpload(req: UploadRequest): Promise<UploadGrant>;
}

export class StorageError extends Error {
  constructor(public code: "bad_key" | "not_configured" | "too_large" | "bad_type" | "exists" | "bad_signature" | "expired") {
    super(code);
  }
}

export const DEFAULT_GET_TTL_S = 300;
export const DEFAULT_UPLOAD_TTL_S = 900;
export const MAX_UPLOAD_TTL_S = 6 * 3600;

export function uploadTtl(req: UploadRequest) {
  return Math.max(30, Math.min(MAX_UPLOAD_TTL_S, Math.floor(req.ttlSeconds ?? DEFAULT_UPLOAD_TTL_S)));
}

/** Does `mime` match one of the allowed patterns (`image/*` style wildcards allowed)? */
export function mimeAllowed(mime: string, allowed: string[]): boolean {
  const m = mime.split(";")[0].trim().toLowerCase();
  return allowed.some((a) => {
    const p = a.trim().toLowerCase();
    return p.endsWith("/*") ? m.startsWith(p.slice(0, -1)) : m === p;
  });
}
