import { and, eq } from "drizzle-orm";
import { events, functions, households } from "@/db/schema";
import { createTranslator } from "@/i18n/core";
import { registerArchivePart, type ArchiveEntry } from "./archive";
import { makeUnsubscribeToken } from "./broadcasts";
import { splitParts, zipItems, zipPath } from "./gallery";
import { guestLinkUrl } from "./guest-links";
import { registerTemplate } from "./outbox";
import { getStore } from "./storage";

/**
 * The gallery's registrations with shared extension points. Imported by `templates.ts` (so every
 * outbox drainer and the daily cron have them) and by pages that show the archive. (The usage
 * sources live in `storage-sources.ts`.)
 *
 * - archive parts `gallery-1..n` with the originals, each up to 400 MB / 500 files (EVT-08)
 * - outbox template `gallery_ready` (GAL-11)
 */

registerArchivePart({
  async listParts(db, eventId, t) {
    const parts = splitParts(await zipItems(db, eventId));
    return parts.map((p, i) => ({ id: `gallery-${i + 1}`, label: t("gallery.archivePart", { n: i + 1, total: parts.length }), bytes: p.reduce((a, x) => a + x.originalBytes, 0) }));
  },
  async *entries(ctx, partId) {
    const n = Number(partId.replace(/^gallery-/, ""));
    const parts = splitParts(await zipItems(ctx.db, ctx.event.id));
    const part = parts[n - 1];
    if (!part) return;
    const store = getStore();
    const folder = ctx.t("gallery.archiveFolder");
    for (const it of part) {
      const entry: ArchiveEntry = {
        path: `${folder}/${zipPath(it, (k) => ctx.t(`gallery.albumKinds.${k}`), ctx.event.timezone)}`,
        data: async () => (await store.get(it.originalKey))?.stream ?? null,
        mtime: it.takenAt,
      };
      yield entry;
    }
  },
});

/** "Photos from the Sangeet are ready" with the family's own link into the gallery (GAL-11). */
registerTemplate("gallery_ready", async (vars, locale, { db, row }) => {
  const t = createTranslator(locale);
  if (!row.eventId || !row.householdId) throw new Error("gallery_ready without event/household");
  const [ev] = await db.select({ name: events.name, coupleNames: events.coupleNames }).from(events).where(eq(events.id, row.eventId));
  const [fn] = await db
    .select({ name: functions.name })
    .from(functions)
    .where(and(eq(functions.id, String(vars.functionId ?? "")), eq(functions.eventId, row.eventId)));
  const [h] = await db
    .select()
    .from(households)
    .where(and(eq(households.id, row.householdId), eq(households.eventId, row.eventId)));
  if (!ev || !fn || !h) throw new Error("gallery_ready: missing rows");
  const appUrl = String(vars.appUrl ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  const lines = [t("gallery.readyMessage", { event: ev.coupleNames || ev.name, function: fn.name })];
  if (row.channel === "whatsapp" || row.channel === "sms") lines.push(t("broadcasts.stopLine"));
  if (!h.linkRevokedAt) lines.push(t("gallery.readyLink", { link: `${guestLinkUrl(appUrl, h)}?to=gallery` }));
  if (row.channel === "email") lines.push("", t("broadcasts.unsubscribeLine", { link: `${appUrl}/u/${makeUnsubscribeToken(row.eventId, "email", row.toAddress)}` }));
  return { subject: t("gallery.readySubject", { function: fn.name }), text: lines.join("\n") };
});
