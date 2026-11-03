import { getFsStore, StorageError } from "@/lib/storage";
import { mimeAllowed, verifyDevUrl } from "@/lib/storage/fs";

/**
 * Development/test stand-in for presigned object URLs (ADR-0030). Only active with the
 * filesystem driver; the HMAC-signed query (operation, key, expiry, limits) is the authorisation,
 * exactly like a presigned Blob URL. Never cached.
 */

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } as const;

function deny(e: unknown) {
  if (e instanceof StorageError) {
    const status = e.code === "too_large" ? 413 : e.code === "exists" ? 409 : e.code === "bad_type" ? 415 : 403;
    return new Response(e.code, { status, headers: NO_STORE });
  }
  throw e;
}

export async function GET(req: Request, { params }: RouteContext<"/api/dev-blob/[...key]">) {
  const store = getFsStore();
  if (!store) return new Response("Not found", { status: 404 });
  const key = (await params).key.join("/");
  try {
    verifyDevUrl(key, "get", new URL(req.url).searchParams);
  } catch (e) {
    return deny(e);
  }
  const obj = await store.get(key);
  if (!obj) return new Response("Not found", { status: 404, headers: NO_STORE });
  return new Response(obj.stream, {
    headers: {
      ...NO_STORE,
      "Content-Type": obj.mime,
      ...(obj.size != null ? { "Content-Length": String(obj.size) } : {}),
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export async function PUT(req: Request, { params }: RouteContext<"/api/dev-blob/[...key]">) {
  const store = getFsStore();
  if (!store) return new Response("Not found", { status: 404 });
  const key = (await params).key.join("/");
  try {
    const p = verifyDevUrl(key, "put", new URL(req.url).searchParams);
    const max = p.max ?? 0;
    const mime = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    if (!mimeAllowed(mime, (p.ct ?? "").split(",").filter(Boolean))) throw new StorageError("bad_type");
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > max) throw new StorageError("too_large");
    if (!req.body) throw new StorageError("too_large");
    const { size } = await store.putStream(key, req.body, mime, max);
    return Response.json({ key, size }, { headers: NO_STORE });
  } catch (e) {
    return deny(e);
  }
}
