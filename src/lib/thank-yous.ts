import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  checkIns,
  events,
  functions,
  gifts,
  guests,
  households,
  outboundMessages,
  rsvps,
  thankYous,
  thankYouTemplates,
  type MessageChannel,
  type ThankYou,
} from "@/db/schema";
import { createTranslator, isLocale } from "@/i18n/core";
import { audit } from "./audit";
import { DeliveryError } from "./delivery";
import { MONEY_TYPES, type GiftCtx } from "./gifts";
import { notifyHosts } from "./notifications";
import { enqueue, estimate, planMessages, registerTemplate, type EnqueueItem } from "./outbox";
import { assertCan } from "./policy";
import { todayIn } from "./tasks";

/**
 * Thank-you tracker and notes (GFT-08..10). Merge fields are a fixed whitelist without any
 * amount; notes are scrubbed of money amounts before they are stored and again when sent.
 */

export class ThankYouError extends Error {
  constructor(public code: "not_found" | "invalid" | "stale" | "unknown_field" | "contains_amount" | "not_drafted" | "no_template" | "already_sent" | "not_failed") {
    super(code);
  }
}

export const MERGE_FIELDS = ["guestName", "coupleNames", "functionsAttended", "giftItem", "personalLine"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
/** Everything a note can contain. There is deliberately no amount here. */
export type NoteVars = Record<MergeField, string>;

/** Money written as ₹ 5,100 / Rs. 5100 / INR 5100 / 5100 rupees / ५१०० रुपये. */
const AMOUNT = /(?:₹|\b(?:rs|inr)\.?)\s*[\d०-९][\d०-९,.\s]*|[\d०-९][\d०-९,.]*\s*(?:\/-|rupees?|rupaye|रुपये|रुपए|रुपया|रु\.?)/giu;

export function containsAmount(text: string): boolean {
  AMOUNT.lastIndex = 0;
  return AMOUNT.test(text) || /₹/.test(text);
}

/** Removes anything that looks like a money amount (and stray ₹ signs). */
export function scrubAmounts(text: string): string {
  return text
    .replace(AMOUNT, "")
    .replace(/₹/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** Gift items with ₹ or digits get a warning before a note is drafted from them. */
export function itemNeedsCheck(item: string): boolean {
  return /[₹\d०-९]/.test(item);
}

/** Placeholders used in a template body, e.g. {guestName}. */
export function templateFields(body: string): string[] {
  return [...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/** A template may only use the whitelisted fields and may not contain an amount. */
export function validateTemplate(body: string): void {
  const bad = templateFields(body).filter((f) => !(MERGE_FIELDS as readonly string[]).includes(f));
  if (bad.length) throw new ThankYouError("unknown_field");
  if (containsAmount(body)) throw new ThankYouError("contains_amount");
}

/** Fills a template. Only whitelisted fields exist, and the result is scrubbed of amounts. */
export function renderNote(body: string, vars: NoteVars): string {
  const filled = body.replace(/\{(\w+)\}/g, (m, k: string) => ((MERGE_FIELDS as readonly string[]).includes(k) ? (vars[k as MergeField] ?? "") : ""));
  return scrubAmounts(filled)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const templateInput = z.object({
  locale: z.string().refine(isLocale),
  name: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(2000),
});

export async function listTemplates(db: Tx, c: GiftCtx) {
  assertCan(c.subject, "gifts.view");
  return db.select().from(thankYouTemplates).where(eq(thankYouTemplates.eventId, c.eventId)).orderBy(asc(thankYouTemplates.locale), asc(thankYouTemplates.name));
}

export async function saveTemplate(db: Database, c: GiftCtx, templateId: string | null, input: z.input<typeof templateInput>) {
  assertCan(c.subject, "gifts.manage");
  const r = templateInput.safeParse(input);
  if (!r.success) throw new ThankYouError("invalid");
  validateTemplate(r.data.body);
  return db.transaction(async (tx) => {
    let row;
    if (templateId) {
      [row] = await tx
        .update(thankYouTemplates)
        .set(r.data)
        .where(and(eq(thankYouTemplates.id, templateId), eq(thankYouTemplates.eventId, c.eventId)))
        .returning();
      if (!row) throw new ThankYouError("not_found");
    } else {
      [row] = await tx
        .insert(thankYouTemplates)
        .values({ ...r.data, eventId: c.eventId })
        .returning();
    }
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "thank_you.template_saved", entityType: "thank_you_template", entityId: row.id, data: { name: row.name } });
    return row;
  });
}

export async function deleteTemplate(db: Database, c: GiftCtx, templateId: string) {
  assertCan(c.subject, "gifts.manage");
  const [row] = await db
    .delete(thankYouTemplates)
    .where(and(eq(thankYouTemplates.id, templateId), eq(thankYouTemplates.eventId, c.eventId)))
    .returning();
  if (!row) throw new ThankYouError("not_found");
}

// ---------------------------------------------------------------------------
// Tracker (GFT-08)
// ---------------------------------------------------------------------------

export type TrackerRow = {
  householdId: string;
  householdName: string;
  side: string;
  locale: string;
  thankYouId: string | null;
  status: ThankYou["status"];
  channel: ThankYou["channel"];
  draftText: string | null;
  version: number;
  sentAt: Date | null;
  sentByName: string | null;
  giftCount: number;
  attended: boolean;
  delivery: string | null;
};

/** Outbound statuses meaning the note didn't reach the family (the latest attempt, after fallbacks). */
export const FAILED_DELIVERY = new Set(["failed", "skipped_optout", "skipped_quota", "skipped_unavailable"]);
export const deliveryFailed = (status: string | null | undefined) => !!status && FAILED_DELIVERY.has(status);

export const trackerFilterKeys = ["status", "gift", "attended", "q"] as const;
export type TrackerFilters = Partial<Record<(typeof trackerFilterKeys)[number], string>>;

export async function listTracker(db: Tx, c: GiftCtx, filters: TrackerFilters = {}): Promise<TrackerRow[]> {
  assertCan(c.subject, "gifts.view");
  const giftCount = sql<number>`(select count(*) from ${gifts} where ${gifts.householdId} = ${households.id})::int`;
  const attended = sql<boolean>`exists (select 1 from ${checkIns} ci join ${guests} g on g.id = ci.guest_id where g.household_id = ${households.id})`;
  const sentBy = sql<string | null>`(select name from users where id = ${thankYous.sentBy})`;
  const delivery = sql<string | null>`(select o.status from ${outboundMessages} o where o.thank_you_id = ${thankYous.id} order by o.created_at desc limit 1)`;
  const conds: (SQL | undefined)[] = [eq(households.eventId, c.eventId)];
  const st = filters.status;
  if (st === "not_started") conds.push(or(isNull(thankYous.id), eq(thankYous.status, "not_started")));
  else if (st === "drafted" || st === "sent" || st === "not_needed") conds.push(eq(thankYous.status, st));
  if (filters.gift === "yes") conds.push(sql`${giftCount} > 0`);
  if (filters.gift === "no") conds.push(sql`${giftCount} = 0`);
  if (filters.attended === "yes") conds.push(attended);
  if (filters.q) conds.push(sql`${households.name} ilike ${`%${filters.q.replace(/[\\%_]/g, "\\$&")}%`}`);
  const rows = await db
    .select({
      householdId: households.id,
      householdName: households.name,
      side: households.side,
      locale: households.locale,
      thankYouId: thankYous.id,
      status: thankYous.status,
      channel: thankYous.channel,
      draftText: thankYous.draftText,
      version: thankYous.version,
      sentAt: thankYous.sentAt,
      sentByName: sentBy,
      giftCount,
      attended,
      delivery,
    })
    .from(households)
    .leftJoin(thankYous, eq(thankYous.householdId, households.id))
    .where(and(...conds))
    .orderBy(asc(households.name))
    .limit(2000);
  return rows.map((r) => ({ ...r, status: r.status ?? "not_started", version: r.version ?? 0 }));
}

/** Merge values for one family: never an amount. */
export async function noteVarsFor(db: Tx, eventId: string, householdId: string, personalLine = ""): Promise<{ vars: NoteVars; itemWarning: boolean }> {
  const [h] = await db.select({ name: households.name }).from(households).where(and(eq(households.id, householdId), eq(households.eventId, eventId)));
  if (!h) throw new ThankYouError("not_found");
  const [ev] = await db.select({ name: events.name, coupleNames: events.coupleNames }).from(events).where(eq(events.id, eventId));
  const checked = await db
    .selectDistinct({ name: functions.name, date: functions.date })
    .from(checkIns)
    .innerJoin(guests, eq(guests.id, checkIns.guestId))
    .innerJoin(functions, eq(functions.id, checkIns.functionId))
    .where(eq(guests.householdId, householdId))
    .orderBy(asc(functions.date));
  const attended = checked.length
    ? checked
    : await db
        .selectDistinct({ name: functions.name, date: functions.date })
        .from(rsvps)
        .innerJoin(guests, eq(guests.id, rsvps.guestId))
        .innerJoin(functions, eq(functions.id, rsvps.functionId))
        .where(and(eq(guests.householdId, householdId), eq(rsvps.status, "attending")))
        .orderBy(asc(functions.date));
  const items = (await db.select({ type: gifts.type, item: gifts.itemDescription }).from(gifts).where(and(eq(gifts.eventId, eventId), eq(gifts.householdId, householdId))))
    .filter((g) => !MONEY_TYPES.has(g.type) && g.item)
    .map((g) => g.item!);
  const itemWarning = items.some(itemNeedsCheck);
  return {
    vars: {
      guestName: h.name,
      coupleNames: ev?.coupleNames || ev?.name || "",
      functionsAttended: attended.map((f) => f.name).join(", "),
      giftItem: scrubAmounts(items.join(", ")).trim(),
      personalLine: personalLine.trim(),
    },
    itemWarning,
  };
}

async function lockRow(tx: Tx, eventId: string, householdId: string) {
  const [h] = await tx.select({ id: households.id }).from(households).where(and(eq(households.id, householdId), eq(households.eventId, eventId))).for("update");
  if (!h) throw new ThankYouError("not_found");
  const [row] = await tx.select().from(thankYous).where(eq(thankYous.householdId, householdId));
  return row ?? null;
}

/**
 * Saves a family's draft: from a template (with a personal line) or edited text. The stored
 * text never contains an amount. A note already sent can't be changed (reopen it first, or use
 * "send again" when its delivery failed).
 */
export async function saveDraft(
  db: Database,
  c: GiftCtx,
  householdId: string,
  input: { templateId?: string | null; personalLine?: string | null; text?: string | null; version?: number },
) {
  assertCan(c.subject, "gifts.manage");
  return db.transaction(async (tx) => {
    const row = await lockRow(tx, c.eventId, householdId);
    if (row?.status === "sent") throw new ThankYouError("already_sent");
    if (input.version !== undefined && (row?.version ?? 0) !== input.version) throw new ThankYouError("stale");
    let text: string;
    let templateId: string | null = row?.templateId ?? null;
    if (input.text != null && input.text.trim()) {
      if (containsAmount(input.text)) throw new ThankYouError("contains_amount");
      text = input.text.trim().slice(0, 2000);
    } else {
      if (!input.templateId) throw new ThankYouError("no_template");
      const [tpl] = await tx.select().from(thankYouTemplates).where(and(eq(thankYouTemplates.id, input.templateId), eq(thankYouTemplates.eventId, c.eventId)));
      if (!tpl) throw new ThankYouError("no_template");
      const { vars } = await noteVarsFor(tx, c.eventId, householdId, (input.personalLine ?? "").slice(0, 300));
      // No item recorded: a plain "gift" in the template's language keeps the sentence whole.
      if (!vars.giftItem) vars.giftItem = createTranslator(isLocale(tpl.locale) ? tpl.locale : "en")("thankYous.giftFallback");
      text = renderNote(tpl.body, vars);
      templateId = tpl.id;
    }
    const status = "drafted";
    if (row) {
      const [r] = await tx.update(thankYous).set({ draftText: text, templateId, status, version: row.version + 1, updatedAt: new Date() }).where(eq(thankYous.id, row.id)).returning();
      return r;
    }
    const [r] = await tx.insert(thankYous).values({ eventId: c.eventId, householdId, draftText: text, templateId, status }).returning();
    return r;
  });
}

/** Drafts notes for families not started yet, from a template (each is reviewed before sending). */
export async function draftMany(db: Database, c: GiftCtx, templateId: string, householdIds: string[]) {
  assertCan(c.subject, "gifts.manage");
  let n = 0;
  for (const id of householdIds.slice(0, 500)) {
    const [existing] = await db.select({ status: thankYous.status }).from(thankYous).where(eq(thankYous.householdId, id));
    if (existing && existing.status !== "not_started") continue;
    await saveDraft(db, c, id, { templateId });
    n++;
  }
  return n;
}

/** Marks a family thanked outside the app (printed card, in person) or not needed / reopened. */
export async function setStatus(
  db: Database,
  c: GiftCtx,
  householdId: string,
  status: "not_started" | "not_needed" | "sent",
  channel: "printed" | "in_person" | null = null,
) {
  assertCan(c.subject, "gifts.manage");
  await db.transaction(async (tx) => {
    const row = await lockRow(tx, c.eventId, householdId);
    const set = {
      status,
      channel: status === "sent" ? channel : (row?.channel ?? null),
      sentAt: status === "sent" ? new Date() : status === "not_started" ? null : (row?.sentAt ?? null),
      sentBy: status === "sent" ? c.actor.userId : status === "not_started" ? null : (row?.sentBy ?? null),
      updatedAt: new Date(),
    };
    if (row) await tx.update(thankYous).set({ ...set, version: row.version + 1 }).where(eq(thankYous.id, row.id));
    else await tx.insert(thankYous).values({ eventId: c.eventId, householdId, ...set });
    const [h] = await tx.select({ name: households.name }).from(households).where(eq(households.id, householdId));
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: `thank_you.${status}`, entityType: "household", entityId: householdId, data: { name: h?.name ?? "" } });
  });
}

// ---------------------------------------------------------------------------
// Sending (GFT-09)
// ---------------------------------------------------------------------------

registerTemplate("thank_you", async (vars, _locale, { db, row }) => {
  // The note as it was when sent (snapshotted at enqueue); rows queued before that read the draft.
  if (vars.text != null) return { subject: vars.subject == null ? undefined : String(vars.subject), text: scrubAmounts(String(vars.text)) };
  if (!row.thankYouId) throw new DeliveryError("no thank-you");
  const [ty] = await db.select({ text: thankYous.draftText }).from(thankYous).where(eq(thankYous.id, row.thankYouId));
  if (!ty?.text) throw new DeliveryError("no draft");
  return { subject: vars.subject == null ? undefined : String(vars.subject), text: scrubAmounts(ty.text) };
});

async function messagesFor(tx: Tx, eventId: string, ids: string[], bulk: boolean) {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ ty: thankYous, household: households })
    .from(thankYous)
    .innerJoin(households, eq(households.id, thankYous.householdId))
    .where(and(eq(thankYous.eventId, eventId), inArray(thankYous.id, ids), eq(thankYous.status, "drafted")))
    .orderBy(asc(households.name));
  const members = rows.length
    ? await tx
        .select({ householdId: guests.householdId, phone: guests.phone, email: guests.email, isHead: guests.isHead })
        .from(guests)
        .where(
          inArray(
            guests.householdId,
            rows.map((r) => r.household.id),
          ),
        )
        .orderBy(desc(guests.isHead), asc(guests.sortOrder))
    : [];
  const [ev] = await tx.select({ name: events.name, coupleNames: events.coupleNames }).from(events).where(eq(events.id, eventId));
  return rows
    .filter((r) => r.ty.draftText)
    .map((r) => {
      const ms = members.filter((m) => m.householdId === r.household.id);
      const phone = ms.find((m) => m.phone)?.phone ?? null;
      const email = ms.find((m) => m.email)?.email ?? null;
      const pref = r.household.preferredChannel as MessageChannel | null;
      const item: EnqueueItem = {
        eventId,
        purpose: "thank_you",
        templateKey: "thank_you",
        // The text is snapshotted here, so editing the note later never changes what goes out.
        vars: { subject: ev?.coupleNames || ev?.name || "", text: scrubAmounts(r.ty.draftText!) },
        recipient: { householdId: r.household.id, addresses: { whatsapp: phone, sms: phone, email }, locale: r.household.locale, preferred: pref && ["whatsapp", "email", "sms"].includes(pref) ? pref : null },
        channels: ["whatsapp", "email", "sms"],
        bulk,
        key: `ty:${r.ty.id}:${r.ty.version}`,
        thankYouId: r.ty.id,
      };
      return { ty: r.ty, item };
    });
}

/** LIM-02: what sending these drafted notes would use, per channel. */
export async function estimateSend(db: Tx, c: GiftCtx, thankYouIds: string[]) {
  assertCan(c.subject, "gifts.manage");
  const msgs = await messagesFor(db, c.eventId, thankYouIds, true);
  return { count: msgs.length, ...(await estimate(db, c.eventId, msgs.map((m) => m.item))) };
}

/**
 * Sends reviewed notes. Only rows in "drafted" are sent (so bulk send can't skip review);
 * each is queued once per version and marked sent. Families without a usable address stay drafted.
 */
export async function sendThankYous(db: Database, c: GiftCtx, thankYouIds: string[], opts: { bulk: boolean }) {
  assertCan(c.subject, "gifts.manage");
  const ids = [...new Set(thankYouIds)].slice(0, 1000);
  return db.transaction(async (tx) => {
    if (ids.length) await tx.select({ id: thankYous.id }).from(thankYous).where(and(eq(thankYous.eventId, c.eventId), inArray(thankYous.id, ids))).for("update");
    const msgs = await messagesFor(tx, c.eventId, ids, opts.bulk);
    const plan = await planMessages(
      tx,
      msgs.map((m) => m.item),
    );
    const sendable = msgs.filter((_, i) => plan[i].channel);
    const res = await enqueue(
      tx,
      sendable.map((m) => m.item),
    );
    const now = new Date();
    for (let i = 0; i < msgs.length; i++) {
      const channel = plan[i].channel;
      if (!channel) continue;
      await tx
        .update(thankYous)
        .set({ status: "sent", channel, sentAt: now, sentBy: c.actor.userId, version: msgs[i].ty.version + 1, updatedAt: now })
        .where(eq(thankYous.id, msgs[i].ty.id));
    }
    if (sendable.length) await audit(tx, { eventId: c.eventId, actor: c.actor, action: "thank_you.sent_messages", entityType: "event", entityId: c.eventId, data: { count: sendable.length } });
    return { sent: sendable.length, noAddress: msgs.length - sendable.length, notDrafted: ids.length - msgs.length, queued: res.queued };
  });
}

/** The latest delivery attempt of a thank-you (after any channel fallbacks). */
async function latestDelivery(db: Tx, thankYouId: string) {
  const [d] = await db
    .select({ status: outboundMessages.status, channel: outboundMessages.channel })
    .from(outboundMessages)
    .where(eq(outboundMessages.thankYouId, thankYouId))
    .orderBy(desc(outboundMessages.createdAt))
    .limit(1);
  return d ?? null;
}

/**
 * A note whose delivery failed on every channel goes back to "drafted" and is sent again (the
 * team may first fix the family's contact details). Families without a usable contact stay
 * drafted, so the note can be edited or marked thanked another way.
 */
export async function resendThankYou(db: Database, c: GiftCtx, householdId: string) {
  assertCan(c.subject, "gifts.manage");
  const id = await db.transaction(async (tx) => {
    const row = await lockRow(tx, c.eventId, householdId);
    if (!row || row.status !== "sent") throw new ThankYouError("not_failed");
    const d = await latestDelivery(tx, row.id);
    if (!deliveryFailed(d?.status)) throw new ThankYouError("not_failed");
    await tx.update(thankYous).set({ status: "drafted", version: row.version + 1, updatedAt: new Date() }).where(eq(thankYous.id, row.id));
    return row.id;
  });
  return sendThankYous(db, c, [id], { bulk: false });
}

// ---------------------------------------------------------------------------
// Printed cards
// ---------------------------------------------------------------------------

export async function addressLabels(db: Tx, c: GiftCtx, filters: TrackerFilters = {}) {
  assertCan(c.subject, "gifts.view");
  const rows = await listTracker(db, c, filters);
  const ids = rows.map((r) => r.householdId);
  if (ids.length === 0) return [];
  const hs = await db
    .select({ id: households.id, name: households.name, address: households.address, city: households.city, postalCode: households.postalCode })
    .from(households)
    .where(and(eq(households.eventId, c.eventId), inArray(households.id, ids)))
    .orderBy(asc(households.name));
  return hs;
}

export async function labelsXlsx(rows: Awaited<ReturnType<typeof addressLabels>>, headers: { name: string; address: string; city: string; postalCode: string }) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Labels");
  ws.columns = [
    { header: headers.name, key: "name", width: 32 },
    { header: headers.address, key: "address", width: 48 },
    { header: headers.city, key: "city", width: 20 },
    { header: headers.postalCode, key: "postalCode", width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow({ name: r.name, address: r.address ?? "", city: r.city ?? "", postalCode: r.postalCode ?? "" });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Reminders (GFT-10)
// ---------------------------------------------------------------------------

export const THANK_YOU_REMINDER_WEEKS = 4;

/**
 * Weekly, from N weeks after the event's last function, Hosts are told how many families who
 * gave a gift or attended still aren't thanked. Run daily; it fires on the weekly anniversary.
 */
export async function sendThankYouReminders(db: Database, now = new Date()): Promise<number> {
  const evs = await db
    .select({ id: events.id, timezone: events.timezone, last: sql<string | null>`(select max(f.date) from functions f where f.event_id = "events"."id")::text` })
    .from(events)
    .where(isNull(events.deletedAt));
  let sent = 0;
  for (const ev of evs) {
    if (!ev.last) continue;
    const today = todayIn(ev.timezone, now);
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ev.last}T00:00:00Z`)) / 86_400_000);
    const start = THANK_YOU_REMINDER_WEEKS * 7;
    if (days < start || (days - start) % 7 !== 0) continue;
    const count = await unthankedCount(db, ev.id);
    if (count === 0) continue;
    await db.transaction((tx) => notifyHosts(tx, ev.id, { kind: "thank_you.reminder", data: { count }, href: `/events/${ev.id}/gifts/thank-yous` }));
    sent++;
  }
  return sent;
}

/** Families who gave a gift or checked in, without a sent / not-needed thank-you. */
export async function unthankedCount(db: Tx, eventId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(households)
    .leftJoin(thankYous, eq(thankYous.householdId, households.id))
    .where(
      and(
        eq(households.eventId, eventId),
        sql`coalesce(${thankYous.status}::text, 'not_started') not in ('sent', 'not_needed')`,
        sql`(exists (select 1 from ${gifts} where ${gifts.householdId} = ${households.id}) or exists (select 1 from ${checkIns} ci join ${guests} g on g.id = ci.guest_id where g.household_id = ${households.id}))`,
      ),
    );
  return r.n;
}


/** One family's thank-you page: their row (if any), gifts (no amounts) and merge preview. */
export async function getThankYou(db: Tx, c: GiftCtx, householdId: string) {
  assertCan(c.subject, "gifts.view");
  const [h] = await db.select().from(households).where(and(eq(households.id, householdId), eq(households.eventId, c.eventId)));
  if (!h) throw new ThankYouError("not_found");
  const [row] = await db.select().from(thankYous).where(eq(thankYous.householdId, householdId));
  const giftList = await db
    .select({ id: gifts.id, type: gifts.type, item: gifts.itemDescription, functionName: functions.name })
    .from(gifts)
    .leftJoin(functions, eq(functions.id, gifts.functionId))
    .where(and(eq(gifts.eventId, c.eventId), eq(gifts.householdId, householdId)));
  const delivery = row ? await latestDelivery(db, row.id) : null;
  const { vars, itemWarning } = await noteVarsFor(db, c.eventId, householdId);
  return { household: h, row: row ?? null, gifts: giftList, vars, itemWarning, delivery };
}
