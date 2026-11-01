import path from "node:path";
import { BlobStore } from "./blob";
import { FsStore } from "./fs";
import { StorageError, type ObjectStore, type StorageDriver } from "./types";

export * from "./types";
export * from "./keys";

/**
 * Which driver to use: `STORAGE_DRIVER=blob|fs`; by default `blob` when `BLOB_READ_WRITE_TOKEN`
 * is set (Vercel injects it when the store is connected), otherwise `fs` under
 * `STORAGE_FS_ROOT` (default `.data/blobs`, gitignored).
 */
export function storageDriver(): StorageDriver {
  const explicit = process.env.STORAGE_DRIVER;
  if (explicit === "blob" || explicit === "fs") return explicit;
  return process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "fs";
}

/**
 * In production the filesystem driver must be chosen on purpose (`STORAGE_DRIVER=fs`, e.g. a
 * container with a persistent volume, or the e2e run). A production server that silently fell
 * back to `fs` because the Blob token is missing would write files nobody can find again.
 */
export function storageMisconfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV !== "production") return false;
  if (env.STORAGE_DRIVER === "blob") return !env.BLOB_READ_WRITE_TOKEN;
  return !env.BLOB_READ_WRITE_TOKEN && env.STORAGE_DRIVER !== "fs";
}

const g = globalThis as unknown as { __eventhubStore?: ObjectStore };

export function getStore(): ObjectStore {
  if (g.__eventhubStore) return g.__eventhubStore;
  const driver = storageDriver();
  if (storageMisconfigured()) throw new StorageError("not_configured");
  if (driver === "fs" && process.env.VERCEL) {
    // Function filesystems on Vercel are ephemeral; files would vanish (ADR-0030).
    throw new StorageError("not_configured");
  }
  g.__eventhubStore = driver === "blob" ? new BlobStore() : new FsStore(path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_FS_ROOT ?? ".data/blobs"));
  return g.__eventhubStore;
}

/** The filesystem store, when it's the active driver (the dev-blob route needs it). */
export function getFsStore(): FsStore | null {
  if (storageDriver() !== "fs" || storageMisconfigured()) return null;
  let s: ObjectStore;
  try {
    s = getStore();
  } catch {
    return null;
  }
  return s instanceof FsStore ? s : null;
}

/** Tests: swap the store (pass null to go back to the env-configured one). */
export function setStoreForTests(store: ObjectStore | null) {
  g.__eventhubStore = store ?? undefined;
}

export { BlobStore, FsStore };
