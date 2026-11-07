import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";
import { asc, eq } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { documents, type DocumentRow, type Event } from "@/db/schema";
import type { Locale, Translator } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import { documentBytes } from "./documents";
import {
  buildBudgetWorkbook,
  buildGiftsWorkbook,
  buildHeadcountWorkbook,
  buildInvoicesHtml,
  buildPayablesWorkbook,
  buildPaymentsWorkbook,
  buildRunSheetsHtml,
  buildVendorsWorkbook,
  guestExportLabels,
} from "./exports";
import { listFunctions } from "./functions";
import type { GiftCtx } from "./gifts";
import { buildGuestWorkbook } from "./guest-import";
import { listAllGuests } from "./guests";
import { payables } from "./payments";
import type { PolicySubject } from "./policy";
import { todayIn } from "./tasks";

/**
 * Full event archive (EVT-08): one-click ZIP for Hosts (permission `event.export`, step-up).
 *
 * The archive is split into **parts**, each its own ZIP download, so no single response has to
 * carry the whole gallery (Vercel functions run at most 300 s; fflate writes classic ZIPs, which
 * cap a part below 4 GB and 65,535 files). Part `main` is built in: spreadsheets, printable pages
 * and documents. Other modules add parts with `registerArchivePart` — the gallery (WP-B) adds
 * one or more `gallery-*` parts with the originals, each up to 400 MB / 500 files (ADR-0031).
 */

export type ArchiveContext = {
  db: Database;
  event: Event;
  t: Translator;
  locale: Locale;
  /** The downloader's policy subject (a Host or App Admin); used for gift access. */
  subject: PolicySubject;
  actor: Actor;
  now: Date;
};

/** One file in a ZIP. `data` may be bytes or a function returning bytes/stream (read lazily). */
export type ArchiveEntry = {
  path: string;
  data: Uint8Array | (() => Promise<Uint8Array | ReadableStream<Uint8Array> | null>);
  /** Deflate it (text, HTML). Leave false for already-compressed files (xlsx, jpg, pdf, mp4). */
  compress?: boolean;
  mtime?: Date;
};

export type ArchivePart = { id: string; label: string; /** Approximate size, for the UI. */ bytes: number | null };

/**
 * Extension point (`archiveParts`): a module that stores bytes contributes parts. `listParts`
 * names the parts it has for an event (e.g. `gallery-1`, `gallery-2`); `entries` yields the files
 * of one of them. Part ids must match `/^[a-z0-9-]{1,40}$/`.
 */
export type ArchivePartProvider = {
  listParts(db: Tx, eventId: string, t: Translator): Promise<ArchivePart[]>;
  entries(ctx: ArchiveContext, partId: string): AsyncIterable<ArchiveEntry>;
};

const providers: ArchivePartProvider[] = [];
export function registerArchivePart(provider: ArchivePartProvider) {
  providers.push(provider);
}

export const PART_ID = /^[a-z0-9-]{1,40}$/;

/** Archive downloads allowed per event, part and day; the route uses `allowAttempt`. */
export const ARCHIVE_DOWNLOADS_PER_DAY = 10;

export async function listArchiveParts(db: Tx, eventId: string, t: Translator): Promise<ArchivePart[]> {
  const parts: ArchivePart[] = [{ id: "main", label: t("archive.mainPart"), bytes: null }];
  for (const p of providers) parts.push(...(await p.listParts(db, eventId, t)).filter((x) => PART_ID.test(x.id) && x.id !== "main"));
  return parts;
}

const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(-120) || "file";

const giftCtx = (ctx: ArchiveContext): GiftCtx => ({ eventId: ctx.event.id, actor: ctx.actor, subject: ctx.subject });

/** The built-in part: spreadsheets, printable pages and every uploaded document. */
export async function* mainEntries(ctx: ArchiveContext): AsyncIterable<ArchiveEntry> {
  const { db, event, t, locale } = ctx;
  const eventId = event.id;
  const today = todayIn(event.timezone, ctx.now);
  const sheet = (name: string) => `${t("archive.folders.spreadsheets")}/${safeName(name)}.xlsx`;
  yield { path: "README.txt", data: strToU8(t("archive.readme", { event: event.name, date: today })), compress: true };
  const [rows, fns] = await Promise.all([listAllGuests(db, eventId), listFunctions(db, eventId)]);
  yield { path: sheet(t("archive.sheets.guests")), data: await buildGuestWorkbook(rows, fns, guestExportLabels(t)) };
  yield { path: sheet(t("archive.sheets.headcount")), data: await buildHeadcountWorkbook(db, eventId, t) };
  yield { path: sheet(t("archive.sheets.budget")), data: await buildBudgetWorkbook(db, eventId, t) };
  yield { path: sheet(t("archive.sheets.payments")), data: await buildPaymentsWorkbook(db, eventId, t, locale) };
  yield { path: sheet(t("archive.sheets.payables")), data: await buildPayablesWorkbook(await payables(db, eventId, today, null), t, locale) };
  yield { path: sheet(t("archive.sheets.vendors")), data: await buildVendorsWorkbook(db, eventId, t) };
  yield { path: sheet(t("archive.sheets.gifts")), data: await buildGiftsWorkbook(db, giftCtx(ctx), t, locale) };
  const pages = t("archive.folders.printable");
  yield { path: `${pages}/${safeName(t("archive.runSheetsTitle"))}.html`, data: strToU8(await buildRunSheetsHtml(db, eventId, t, locale)), compress: true };
  yield { path: `${pages}/${safeName(t("archive.invoicesTitle"))}.html`, data: strToU8(await buildInvoicesHtml(db, eventId, t, locale, today)), compress: true };
  const docs = await db.select().from(documents).where(eq(documents.eventId, eventId)).orderBy(asc(documents.createdAt));
  for (const doc of docs) yield documentEntry(db, doc, t);
}

function documentEntry(db: Tx, doc: DocumentRow, t: Translator): ArchiveEntry {
  const folder = `${t("archive.folders.documents")}/${safeName(t(`documents.kinds.${doc.kind}`))}`;
  const read = () => documentBytes(db, doc).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  return {
    path: `${folder}/${doc.createdAt.toISOString().slice(0, 10)}-${doc.id.slice(0, 8)}-${safeName(doc.filename)}`,
    // One retry (a store hiccup); if it still fails, zipStream lists the file in MISSING.txt.
    data: () => read().catch(() => read()),
    mtime: doc.createdAt,
  };
}

/** The entries of a part (`main` or a registered provider's part). */
export async function partEntries(ctx: ArchiveContext, partId: string): Promise<AsyncIterable<ArchiveEntry> | null> {
  if (partId === "main") return mainEntries(ctx);
  if (!PART_ID.test(partId)) return null;
  for (const p of providers) {
    const parts = await p.listParts(ctx.db, ctx.event.id, ctx.t);
    if (parts.some((x) => x.id === partId)) return p.entries(ctx, partId);
  }
  return null;
}

export type ZipOptions = {
  /**
   * Files that couldn't be read (their `data()` threw or returned null) are left out and listed
   * in this text file at the end of the ZIP, so a missing file is never silent.
   */
  missing?: { name: string; header: string };
};

const DEFAULT_MISSING = { name: "MISSING.txt", header: "These files could not be read and are not in this archive:" };

/**
 * Streams entries as a ZIP. Files are added one after another and read lazily, and the producer
 * waits while the consumer's queue is full, so memory stays around one file plus a few MB.
 * Cancelling the response (the browser went away) stops the producer promptly: it stops reading
 * entries, cancels any open source stream and drops the ZIP.
 */
export function zipStream(entries: AsyncIterable<ArchiveEntry>, opts: ZipOptions = {}): ReadableStream<Uint8Array> {
  const missingFile = opts.missing ?? DEFAULT_MISSING;
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let wake: (() => void) | null = null;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const zip = new Zip((err, chunk, final) => {
          if (cancelled) return;
          if (err) {
            cancelled = true;
            return controller.error(err);
          }
          controller.enqueue(chunk);
          if (final) controller.close();
        });
        /** Resolves when the consumer wants more; false once the stream is cancelled or errored. */
        const wait = async (): Promise<boolean> => {
          for (;;) {
            if (cancelled) return false;
            const size = controller.desiredSize;
            if (size === null) {
              cancelled = true;
              return false;
            }
            if (size > 0) return true;
            // Woken by pull() or cancel(); the timer is only a safety net.
            await new Promise<void>((r) => {
              wake = r;
              setTimeout(r, 100);
            });
          }
        };
        void (async () => {
          const iterator = entries[Symbol.asyncIterator]();
          const missing: string[] = [];
          try {
            for (;;) {
              if (!(await wait())) break;
              const step = await iterator.next();
              if (step.done || cancelled) break;
              const e = step.value;
              let data: Uint8Array | ReadableStream<Uint8Array> | null;
              try {
                data = typeof e.data === "function" ? await e.data() : e.data;
              } catch {
                data = null;
              }
              if (cancelled) break;
              if (data == null) {
                missing.push(e.path);
                continue;
              }
              const file = e.compress ? new ZipDeflate(e.path, { level: 6 }) : new ZipPassThrough(e.path);
              if (e.mtime) file.mtime = e.mtime;
              zip.add(file);
              if (data instanceof Uint8Array) {
                file.push(data, true);
              } else {
                reader = data.getReader();
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done || cancelled) break;
                  file.push(value, false);
                  if (!(await wait())) break;
                }
                reader = null;
                if (cancelled) break;
                file.push(new Uint8Array(0), true);
              }
            }
            if (cancelled) {
              zip.terminate();
              return;
            }
            if (missing.length) {
              const note = new ZipDeflate(missingFile.name, { level: 6 });
              zip.add(note);
              note.push(strToU8(`${missingFile.header}\n\n${missing.join("\n")}\n`), true);
            }
            zip.end();
          } catch (err) {
            if (!cancelled) {
              cancelled = true;
              controller.error(err);
            }
          } finally {
            if (cancelled) await iterator.return?.().catch(() => undefined);
          }
        })();
      },
      pull() {
        nudge();
      },
      cancel() {
        cancelled = true;
        nudge();
        // Stop any source stream being read (e.g. a gallery original) right away.
        const r = reader;
        reader = null;
        return r?.cancel().catch(() => undefined);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }),
  );
}

/** Logged: bulk export of guest data is sensitive (EVT-01d, EVT-06). */
export async function recordArchiveDownload(db: Tx, eventId: string, actor: Actor, partId: string) {
  await audit(db, { eventId, actor, action: "event.archive_downloaded", entityType: "event", entityId: eventId, data: { part: partId } });
}
