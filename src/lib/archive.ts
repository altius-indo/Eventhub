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
 * one or more `gallery-*` parts with the originals, each kept under ~2 GB.
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
  yield { path: sheet(t("archive.sheets.gifts")), data: await buildGiftsWorkbook(db, giftCtx(ctx), t) };
  const pages = t("archive.folders.printable");
  yield { path: `${pages}/${safeName(t("archive.runSheetsTitle"))}.html`, data: strToU8(await buildRunSheetsHtml(db, eventId, t, locale)), compress: true };
  yield { path: `${pages}/${safeName(t("archive.invoicesTitle"))}.html`, data: strToU8(await buildInvoicesHtml(db, eventId, t, locale, today)), compress: true };
  const docs = await db.select().from(documents).where(eq(documents.eventId, eventId)).orderBy(asc(documents.createdAt));
  for (const doc of docs) yield documentEntry(db, doc, t);
}

function documentEntry(db: Tx, doc: DocumentRow, t: Translator): ArchiveEntry {
  const folder = `${t("archive.folders.documents")}/${safeName(t(`documents.kinds.${doc.kind}`))}`;
  return {
    path: `${folder}/${doc.createdAt.toISOString().slice(0, 10)}-${doc.id.slice(0, 8)}-${safeName(doc.filename)}`,
    data: () => documentBytes(db, doc).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).catch(() => null),
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

/**
 * Streams entries as a ZIP. Files are added one after another and read lazily, and the producer
 * waits while the consumer's queue is full, so memory stays around one file plus a few MB.
 */
export function zipStream(entries: AsyncIterable<ArchiveEntry>): ReadableStream<Uint8Array> {
  let pending: Promise<void> | null = null;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const zip = new Zip((err, chunk, final) => {
          if (err) return controller.error(err);
          controller.enqueue(chunk);
          if (final) controller.close();
        });
        const wait = async () => {
          while ((controller.desiredSize ?? 1) <= 0) await new Promise((r) => setTimeout(r, 5));
        };
        pending = (async () => {
          try {
            for await (const e of entries) {
              const file = e.compress ? new ZipDeflate(e.path, { level: 6 }) : new ZipPassThrough(e.path);
              if (e.mtime) file.mtime = e.mtime;
              const data = typeof e.data === "function" ? await e.data() : e.data;
              if (data == null) continue;
              zip.add(file);
              if (data instanceof Uint8Array) {
                file.push(data, true);
              } else {
                const reader = data.getReader();
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  file.push(value, false);
                  await wait();
                }
                file.push(new Uint8Array(0), true);
              }
              await wait();
            }
            zip.end();
          } catch (err) {
            controller.error(err);
          }
        })();
      },
      async cancel() {
        await pending?.catch(() => undefined);
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }),
  );
}

/** Logged: bulk export of guest data is sensitive (EVT-01d, EVT-06). */
export async function recordArchiveDownload(db: Tx, eventId: string, actor: Actor, partId: string) {
  await audit(db, { eventId, actor, action: "event.archive_downloaded", entityType: "event", entityId: eventId, data: { part: partId } });
}
