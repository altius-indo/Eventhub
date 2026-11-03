import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { hmac, safeEqual } from "../crypto";
import { assertKey, assertPrefix } from "./keys";
import {
  DEFAULT_GET_TTL_S,
  mimeAllowed,
  StorageError,
  uploadTtl,
  type GetResult,
  type ObjectInfo,
  type ObjectStore,
  type UploadGrant,
  type UploadRequest,
} from "./types";

/**
 * Filesystem store for development and tests (ADR-0030). Bytes live in `<root>/data/<key>` and
 * metadata in `<root>/meta/<key>.json`. Temporary URLs point at `/api/dev-blob/<key>` and carry
 * an HMAC (AUTH_SECRET) over operation, key, expiry and upload limits.
 */

export const DEV_BLOB_ROUTE = "/api/dev-blob/";

type Meta = { mime: string; size: number; uploadedAt: string };

export type SignedParams = { op: "get" | "put"; exp: number; max?: number; ct?: string };

function signature(key: string, p: SignedParams) {
  return hmac(["dev-blob", p.op, key, p.exp, p.max ?? "", p.ct ?? ""].join("|"));
}

export function signedDevUrl(key: string, p: SignedParams): string {
  const q = new URLSearchParams({ op: p.op, exp: String(p.exp) });
  if (p.max != null) q.set("max", String(p.max));
  if (p.ct != null) q.set("ct", p.ct);
  q.set("sig", signature(key, p));
  return `${DEV_BLOB_ROUTE}${key}?${q.toString()}`;
}

/** Checks a `/api/dev-blob` URL's signature and expiry; returns the signed parameters. */
export function verifyDevUrl(key: string, op: "get" | "put", search: URLSearchParams, now = new Date()): SignedParams {
  assertKey(key);
  const exp = Number(search.get("exp"));
  const maxRaw = search.get("max");
  const ct = search.get("ct") ?? undefined;
  const p: SignedParams = { op, exp, ...(maxRaw != null ? { max: Number(maxRaw) } : {}), ...(ct != null ? { ct } : {}) };
  if (search.get("op") !== op || !Number.isFinite(exp)) throw new StorageError("bad_signature");
  if (!safeEqual(search.get("sig") ?? "", signature(key, p))) throw new StorageError("bad_signature");
  if (exp * 1000 < now.getTime()) throw new StorageError("expired");
  return p;
}

export class FsStore implements ObjectStore {
  readonly driver = "fs" as const;
  constructor(readonly root: string) {}

  private dataPath(key: string) {
    return path.join(this.root, "data", ...assertKey(key).split("/"));
  }
  private metaPath(key: string) {
    return path.join(this.root, "meta", ...assertKey(key).split("/")) + ".json";
  }

  private async writeMeta(key: string, meta: Meta) {
    const p = this.metaPath(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(meta));
  }

  async put(key: string, data: Uint8Array, mime: string) {
    const p = this.dataPath(key);
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
    await this.writeMeta(key, { mime, size: data.length, uploadedAt: new Date().toISOString() });
    return { key, size: data.length };
  }

  /**
   * Writes a streamed upload (the dev PUT route). Refuses to overwrite and stops at `maxBytes`;
   * a partial file is removed.
   */
  async putStream(key: string, body: ReadableStream<Uint8Array>, mime: string, maxBytes: number) {
    const p = this.dataPath(key);
    if (await this.head(key)) throw new StorageError("exists");
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    const out = createWriteStream(tmp);
    let size = 0;
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new StorageError("too_large");
        }
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      await rename(tmp, p);
    } catch (e) {
      out.destroy();
      await rm(tmp, { force: true });
      throw e;
    }
    await this.writeMeta(key, { mime, size, uploadedAt: new Date().toISOString() });
    return { key, size };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const s = await stat(this.dataPath(key));
      const meta = await readFile(this.metaPath(key), "utf8")
        .then((t) => JSON.parse(t) as Meta)
        .catch(() => null);
      return { key, size: s.size, mime: meta?.mime ?? "application/octet-stream", uploadedAt: meta ? new Date(meta.uploadedAt) : s.mtime };
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<GetResult | null> {
    const info = await this.head(key);
    if (!info) return null;
    const stream = Readable.toWeb(createReadStream(this.dataPath(key))) as ReadableStream<Uint8Array>;
    return { stream, size: info.size, mime: info.mime ?? "application/octet-stream" };
  }

  async getBytes(key: string) {
    try {
      return await readFile(this.dataPath(key));
    } catch {
      return null;
    }
  }

  async delete(key: string) {
    await rm(this.dataPath(key), { force: true });
    await rm(this.metaPath(key), { force: true });
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    // Walk from the deepest directory the prefix names; filter the rest by string prefix.
    const lastSlash = prefix.lastIndexOf("/");
    const dirKey = prefix.slice(0, lastSlash + 1);
    assertPrefix(dirKey);
    const base = path.join(this.root, "data", ...dirKey.split("/").filter(Boolean));
    const walk = async function* (this: FsStore, dir: string, keyDir: string): AsyncGenerator<ObjectInfo> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) yield* walk.call(this, path.join(dir, e.name), `${keyDir}${e.name}/`);
        else if (e.isFile() && !e.name.endsWith(".tmp")) {
          const key = `${keyDir}${e.name}`;
          if (!key.startsWith(prefix)) continue;
          const info = await this.head(key);
          if (info) yield info;
        }
      }
    };
    yield* walk.call(this, base, dirKey);
  }

  async deleteByPrefix(prefix: string) {
    assertPrefix(prefix);
    let n = 0;
    for await (const o of this.list(prefix)) {
      await this.delete(o.key);
      n++;
    }
    const parts = prefix.split("/").filter(Boolean);
    await rm(path.join(this.root, "data", ...parts), { recursive: true, force: true });
    await rm(path.join(this.root, "meta", ...parts), { recursive: true, force: true });
    return n;
  }

  async presignedGet(key: string, opts: { ttlSeconds?: number } = {}) {
    assertKey(key);
    const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(opts.ttlSeconds ?? DEFAULT_GET_TTL_S));
    return signedDevUrl(key, { op: "get", exp });
  }

  async authorizeUpload(req: UploadRequest): Promise<UploadGrant> {
    assertKey(req.key);
    if (!(req.maxBytes > 0)) throw new StorageError("too_large");
    const exp = Math.floor(Date.now() / 1000) + uploadTtl(req);
    const ct = req.contentTypes.join(",");
    return {
      driver: "fs",
      key: req.key,
      maxBytes: req.maxBytes,
      contentTypes: req.contentTypes,
      expiresAt: new Date(exp * 1000).toISOString(),
      multipart: false,
      url: signedDevUrl(req.key, { op: "put", exp, max: req.maxBytes, ct }),
    };
  }
}

export { mimeAllowed };
