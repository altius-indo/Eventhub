import { BlobNotFoundError, del, get, head, issueSignedToken, list, presignUrl, put } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { assertKey, assertPrefix } from "./keys";
import { DEFAULT_GET_TTL_S, uploadTtl, type GetResult, type ObjectInfo, type ObjectStore, type UploadGrant, type UploadRequest } from "./types";

/**
 * Vercel Blob **private** store (ADR-0030; production store `eventhub-media`, region bom1).
 * Credentials: `BLOB_READ_WRITE_TOKEN` (injected by Vercel when the store is connected), read by
 * the SDK by default. Objects are never public: reads go through our routes or short-lived
 * presigned URLs.
 */
export class BlobStore implements ObjectStore {
  readonly driver = "blob" as const;
  constructor(private readonly token?: string) {}

  private get opts() {
    return this.token ? { token: this.token } : {};
  }

  async put(key: string, data: Uint8Array, mime: string) {
    await put(assertKey(key), Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      ...this.opts,
      access: "private",
      contentType: mime,
      addRandomSuffix: false,
      allowOverwrite: true,
      multipart: data.byteLength > 8 * 1024 * 1024,
    });
    return { key, size: data.byteLength };
  }

  async get(key: string): Promise<GetResult | null> {
    const r = await get(assertKey(key), { ...this.opts, access: "private", useCache: false }).catch((e) => {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    });
    if (!r || r.statusCode !== 200) return null;
    return { stream: r.stream, size: r.blob.size, mime: r.blob.contentType };
  }

  async getBytes(key: string) {
    const r = await this.get(key);
    if (!r) return null;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const h = await head(assertKey(key), this.opts);
      return { key, size: h.size, mime: h.contentType, uploadedAt: h.uploadedAt };
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  }

  async delete(key: string) {
    await del(assertKey(key), this.opts);
  }

  async *list(prefix: string): AsyncIterable<ObjectInfo> {
    let cursor: string | undefined;
    do {
      const page = await list({ ...this.opts, prefix, cursor, limit: 1000 });
      for (const b of page.blobs) yield { key: b.pathname, size: b.size, mime: null, uploadedAt: b.uploadedAt };
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  async deleteByPrefix(prefix: string) {
    assertPrefix(prefix);
    let n = 0;
    let batch: string[] = [];
    for await (const o of this.list(prefix)) {
      batch.push(o.key);
      if (batch.length === 500) {
        await del(batch, this.opts);
        n += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await del(batch, this.opts);
      n += batch.length;
    }
    return n;
  }

  async presignedGet(key: string, opts: { ttlSeconds?: number } = {}) {
    assertKey(key);
    const validUntil = Date.now() + Math.max(1, Math.floor(opts.ttlSeconds ?? DEFAULT_GET_TTL_S)) * 1000;
    const signed = await issueSignedToken({ ...this.opts, pathname: key, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(signed, { operation: "get", pathname: key, access: "private", validUntil });
    return presignedUrl;
  }

  async authorizeUpload(req: UploadRequest): Promise<UploadGrant> {
    assertKey(req.key);
    const validUntil = Date.now() + uploadTtl(req) * 1000;
    const token = await generateClientTokenFromReadWriteToken({
      ...this.opts,
      pathname: req.key,
      maximumSizeInBytes: req.maxBytes,
      allowedContentTypes: req.contentTypes,
      validUntil,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return {
      driver: "blob",
      key: req.key,
      maxBytes: req.maxBytes,
      contentTypes: req.contentTypes,
      expiresAt: new Date(validUntil).toISOString(),
      multipart: req.multipart ?? req.maxBytes > 50 * 1024 * 1024,
      token,
    };
  }
}
