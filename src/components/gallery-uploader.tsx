"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { uploadWithGrant } from "@/lib/storage/client-upload";
import type { UploadGrant } from "@/lib/storage/types";
import { buttonClass } from "./ui";

export type UploaderLabels = Record<
  "choose" | "progress" | "failedCount" | "retry" | "cancel" | "waiting" | "uploading" | "done" | "failed" | "preparing" | "finished" | "tooLong" | "refresh" | "badType" | "tooLarge",
  string
>;

type Status = "waiting" | "preparing" | "uploading" | "done" | "failed";
type Entry = { id: string; file: File; clientKey: string; status: Status; pct: number; error?: string; mediaId?: string };

const EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const mimeOf = (f: File) => (f.type || EXT[f.name.split(".").pop()?.toLowerCase() ?? ""] || "application/octet-stream").toLowerCase();

/** Guests (§4.1): photos as JPEG at most 4096 px; files already within that go up untouched (EXIF kept). */
async function prepareGuestPhoto(file: File, mime: string): Promise<File> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bitmap) return file;
  const long = Math.max(bitmap.width, bitmap.height);
  if (mime === "image/jpeg" && long <= 4096) {
    bitmap.close();
    return file;
  }
  const scale = Math.min(1, 4096 / long);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
}

function videoSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    const url = URL.createObjectURL(file);
    const done = (n: number | null) => {
      URL.revokeObjectURL(url);
      resolve(n);
    };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}

async function post(endpoint: string, body: unknown) {
  const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `${res.status}`);
  return data;
}

/**
 * Direct-to-storage uploads with progress (ADR-0031). Each file gets a client key, so "retry"
 * resumes the same item; two files go at a time. Guests' photos are resized in the browser.
 */
export function GalleryUploader({
  endpoint,
  functionId,
  albumId,
  guest = false,
  accept,
  maxPhotoBytes,
  maxVideoBytes,
  labels,
  className,
}: {
  endpoint: string;
  functionId: string;
  albumId?: string | null;
  guest?: boolean;
  accept: string;
  maxPhotoBytes: number;
  maxVideoBytes: number;
  labels: UploaderLabels;
  className?: string;
}) {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const update = (id: string, patch: Partial<Entry>) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  async function one(e: Entry, signal: AbortSignal) {
    let mediaId = e.mediaId;
    try {
      update(e.id, { status: "preparing", pct: 0, error: undefined });
      let file = e.file;
      let mime = mimeOf(file);
      const isVideo = mime.startsWith("video/");
      if (guest && isVideo) {
        const s = await videoSeconds(file);
        if (s != null && s > 600) throw new Error(labels.tooLong);
      }
      if (guest && mime.startsWith("image/")) {
        file = await prepareGuestPhoto(file, mime);
        mime = file.type || mime;
      }
      if (!/^(image|video)\//.test(mime)) throw new Error(labels.badType);
      if (file.size > (isVideo ? maxVideoBytes : maxPhotoBytes)) throw new Error(labels.tooLarge);
      const begun = await post(endpoint, { action: "begin", functionId, albumId: albumId ?? null, clientKey: e.clientKey, filename: e.file.name, mime, size: file.size });
      mediaId = String(begun.mediaId);
      update(e.id, { mediaId });
      if (!begun.done) {
        update(e.id, { status: "uploading" });
        const typed = file.type === mime ? file : new File([file], file.name, { type: mime });
        await uploadWithGrant(begun.grant as UploadGrant, typed, { signal, onProgress: (pct) => update(e.id, { pct: Math.round(pct) }) });
        await post(endpoint, { action: "complete", mediaId });
      }
      update(e.id, { status: "done", pct: 100 });
    } catch (err) {
      if (signal.aborted && mediaId) await post(endpoint, { action: "abort", mediaId }).catch(() => undefined);
      update(e.id, { status: "failed", error: err instanceof Error && !/^\d+$|^upload_failed/.test(err.message) ? err.message : undefined });
    }
  }

  async function run(list: Entry[]) {
    if (list.length === 0) return;
    setRunning(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const queue = [...list];
    const worker = async () => {
      for (let e = queue.shift(); e && !ctrl.signal.aborted; e = queue.shift()) await one(e, ctrl.signal);
    };
    await Promise.all([worker(), worker()]);
    setRunning(false);
    abort.current = null;
    router.refresh();
  }

  function onPick(files: FileList | null) {
    if (!files?.length) return;
    const added: Entry[] = [...files].map((file) => ({ id: crypto.randomUUID(), file, clientKey: crypto.randomUUID(), status: "waiting", pct: 0 }));
    setEntries((l) => [...l.filter((e) => e.status !== "done"), ...added]);
    if (input.current) input.current.value = "";
    void run(added);
  }

  const done = entries.filter((e) => e.status === "done").length;
  const failed = entries.filter((e) => e.status === "failed");
  const statusText = (e: Entry) =>
    e.status === "uploading" ? labels.uploading.replace("{pct}", String(e.pct)) : e.status === "failed" ? e.error || labels.failed : labels[e.status];

  return (
    <div className={className}>
      <label className={buttonClass("primary", running ? "pointer-events-none opacity-60" : "cursor-pointer")}>
        {labels.choose}
        <input ref={input} type="file" multiple accept={accept} className="sr-only" disabled={running} onChange={(e) => onPick(e.target.files)} />
      </label>
      {entries.length > 0 && (
        <div className="mt-3 space-y-2" aria-live="polite">
          <p className="text-sm">
            {labels.progress.replace("{done}", String(done)).replace("{total}", String(entries.length))}
            {failed.length > 0 && <span className="ms-2 text-danger">{labels.failedCount.replace("{count}", String(failed.length))}</span>}
          </p>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 rounded-md bg-surface-muted px-3 py-2">
                <span className="min-w-0 truncate">{e.file.name}</span>
                <span className={e.status === "failed" ? "shrink-0 text-danger" : "shrink-0 text-muted"}>{statusText(e)}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            {running && (
              <button type="button" className={buttonClass("secondary")} onClick={() => abort.current?.abort()}>
                {labels.cancel}
              </button>
            )}
            {!running && failed.length > 0 && (
              <button type="button" className={buttonClass("secondary")} onClick={() => void run(failed)}>
                {labels.retry}
              </button>
            )}
            {!running && done > 0 && <p className="text-sm text-muted">{labels.finished}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
