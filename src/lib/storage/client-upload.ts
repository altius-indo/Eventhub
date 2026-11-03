/**
 * Browser side of direct uploads (ADR-0030). Import only from client components.
 *
 * ```ts
 * const grant: UploadGrant = await requestGrantFromServer(...); // server: store.authorizeUpload()
 * await uploadWithGrant(grant, file, { onProgress: (pct) => setPct(pct) });
 * await confirmUploadOnServer(grant.key);                        // server: store.head() + quota.commit()
 * ```
 */
import type { UploadGrant } from "./types";

export type UploadProgress = (percentage: number) => void;

export async function uploadWithGrant(grant: UploadGrant, file: Blob, opts: { onProgress?: UploadProgress; signal?: AbortSignal } = {}) {
  if (file.size > grant.maxBytes) throw new Error("too_large");
  const contentType = file.type || "application/octet-stream";
  if (grant.driver === "blob") {
    const { put } = await import("@vercel/blob/client");
    await put(grant.key, file, {
      access: "private",
      token: grant.token!,
      contentType,
      multipart: grant.multipart,
      abortSignal: opts.signal,
      onUploadProgress: opts.onProgress ? (e) => opts.onProgress!(e.percentage) : undefined,
    });
    return { key: grant.key };
  }
  const res = await fetch(grant.url!, { method: "PUT", body: file, headers: { "Content-Type": contentType }, signal: opts.signal });
  if (!res.ok) throw new Error(`upload_failed:${res.status}`);
  opts.onProgress?.(100);
  return { key: grant.key };
}
