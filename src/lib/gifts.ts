import { and, asc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import { eventMembers, events, functions, giftItemRecipients, giftItems, households, users, type GiftItem } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { invitedCounts, type FunctionHeadcount } from "./functions";
import { notify, notifyHosts } from "./notifications";
import { assertCan, type PolicySubject } from "./policy";
import { addDays, todayIn } from "./tasks";

/**
 * Gifts the family gives (GFT-01..07, ADR-0036): a shopping list of what to give, when, how
 * many and (optionally) for whom, with purchase status. Hosts and Planners both view and edit.
 * Quantities can follow the guest list: one per invited family / guest / adult of a function.
 */

export class GiftError extends Error {
  constructor(public code: "not_found" | "invalid" | "stale" | "needs_function" | "needs_quantity" | "bad_function" | "bad_household" | "bad_assignee") {
    super(code);
  }
}

/** What the domain needs from the page/action: event, actor and their policy subject. */
export type GiftCtx = { eventId: string; actor: Actor; subject: PolicySubject };

export const GIFT_CATEGORIES = ["return_gift", "family", "helpers_staff", "vendor", "other"] as const;
export const QUANTITY_MODES = ["fixed", "per_family", "per_guest", "per_adult"] as const;
export const GIFT_STATUSES = ["to_buy", "ordered", "bought", "given"] as const;
export type GiftCategory = (typeof GIFT_CATEGORIES)[number];
export type QuantityMode = (typeof QUANTITY_MODES)[number];
export type GiftStatus = (typeof GIFT_STATUSES)[number];

/** Items not bought and given within this many days count as "due soon" (GFT-06). */
export const DUE_SOON_DAYS = 7;
const MAX_QTY = 100_000;

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const optUuid = z
  .string()
  .uuid()
  .nullish()
  .transform((v) => v ?? null);
const optDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullish()
  .transform((v) => v ?? null);

export const giftItemInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: optText(1000),
  category: z.enum(GIFT_CATEGORIES).default("other"),
  functionId: optUuid,
  giveBy: optDate,
  quantityMode: z.enum(QUANTITY_MODES).default("fixed"),
  quantityFixed: z.number().int().min(0).max(MAX_QTY).nullish().transform((v) => v ?? null),
  quantityFunctionId: optUuid,
  quantityExtra: z.number().int().min(0).max(MAX_QTY).default(0),
  forWhom: optText(200),
  unitCostPaise: z.number().int().min(0).max(1e13).nullish().transform((v) => v ?? null),
  assigneeId: optUuid,
  source: optText(300),
  notes: optText(1000),
  /** Families it's for (optional). Omitted on update = unchanged. */
  householdIds: z.array(z.string().uuid()).max(2000).optional(),
});
export type GiftItemInput = z.input<typeof giftItemInput>;
type GiftValues = z.output<typeof giftItemInput>;

function parseInput(input: GiftItemInput): GiftValues {
  const r = giftItemInput.safeParse(input);
  if (!r.success) throw new GiftError("invalid");
  const v = r.data;
  if (v.quantityMode === "fixed" && v.quantityFixed === null) throw new GiftError("needs_quantity");
  if (v.quantityMode !== "fixed" && !v.quantityFunctionId && !v.functionId) throw new GiftError("needs_function");
  return v;
}

// ---------------------------------------------------------------------------
// Quantities (GFT-03)
// ---------------------------------------------------------------------------

type QtyFields = Pick<GiftItem, "quantityMode" | "quantityFixed" | "quantityFunctionId" | "functionId" | "quantityExtra">;

/** The function whose invitees a linked quantity counts (its own, else the item's function). */
export const countedFunctionId = (item: Pick<GiftItem, "quantityFunctionId" | "functionId">) => item.quantityFunctionId ?? item.functionId;

/**
 * How many are needed: the fixed number, or invited families / guests / adults of the counted
 * function, plus spares. A linked mode without a function (it was deleted) → `needs_function`.
 */
export function neededQuantity(item: QtyFields, counts: Map<string, FunctionHeadcount>): number {
  if (item.quantityMode === "fixed") return item.quantityFixed ?? 0;
  const fnId = countedFunctionId(item);
  if (!fnId) throw new GiftError("needs_function");
  const c = counts.get(fnId);
  const base = !c ? 0 : item.quantityMode === "per_family" ? c.households : item.quantityMode === "per_guest" ? c.guests : c.adults;
  return base + item.quantityExtra;
}

/** Needed quantity, or null when a linked mode lost its function (shown as "choose a function"). */
function neededOrNull(item: QtyFields, counts: Map<string, FunctionHeadcount>): number | null {
  try {
    return neededQuantity(item, counts);
  } catch (e) {
    if (e instanceof GiftError) return null;
    throw e;
  }
}

/** One item's needed quantity, read from the live guest list. */
export async function neededQuantityOf(db: Tx, eventId: string, item: QtyFields): Promise<number> {
  return neededQuantity(item, item.quantityMode === "fixed" ? new Map() : await invitedCounts(db, eventId));
}

/** Status after a change in the bought count: complete purchases become "bought"; "given" never moves back. */
export function autoStatus(status: GiftStatus, bought: number, needed: number | null): GiftStatus {
  if ((status === "to_buy" || status === "ordered") && needed !== null && needed > 0 && bought >= needed) return "bought";
  return status;
}

/** The day the gift is needed: the earlier of the give-by date and the function's date. */
export function whenDate(giveBy: string | null, functionDate: string | null): string | null {
  if (giveBy && functionDate) return giveBy < functionDate ? giveBy : functionDate;
  return giveBy ?? functionDate;
}

/** Not fully bought yet (and not already given). */
export function stillToBuy(status: GiftStatus, bought: number, needed: number | null) {
  if (status === "given") return false;
  if (status === "to_buy" || status === "ordered") return true;
  return needed !== null && bought < needed;
}

// ---------------------------------------------------------------------------
// Create / update / delete (GFT-01..05)
// ---------------------------------------------------------------------------

async function checkRefs(tx: Tx, eventId: string, v: Pick<GiftValues, "functionId" | "quantityFunctionId" | "assigneeId">) {
  const fnIds = [...new Set([v.functionId, v.quantityFunctionId].filter((x): x is string => !!x))];
  if (fnIds.length) {
    const found = await tx
      .select({ id: functions.id })
      .from(functions)
      .where(and(eq(functions.eventId, eventId), inArray(functions.id, fnIds)));
    if (found.length !== fnIds.length) throw new GiftError("bad_function");
  }
  if (v.assigneeId) {
    const [m] = await tx
      .select({ id: eventMembers.id })
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, v.assigneeId)));
    if (!m) throw new GiftError("bad_assignee");
  }
}

/** Replaces the families a gift is for. Every family must belong to this event. */
async function writeRecipients(tx: Tx, eventId: string, giftItemId: string, householdIds: string[]) {
  const ids = [...new Set(householdIds)];
  if (ids.length) {
    const found = await tx
      .select({ id: households.id })
      .from(households)
      .where(and(eq(households.eventId, eventId), inArray(households.id, ids)));
    if (found.length !== ids.length) throw new GiftError("bad_household");
  }
  await tx.delete(giftItemRecipients).where(eq(giftItemRecipients.giftItemId, giftItemId));
  if (ids.length) await tx.insert(giftItemRecipients).values(ids.map((householdId) => ({ giftItemId, householdId, eventId })));
}

const fieldsOf = (v: GiftValues) => ({
  name: v.name,
  description: v.description,
  category: v.category,
  functionId: v.functionId,
  giveBy: v.giveBy,
  quantityMode: v.quantityMode,
  quantityFixed: v.quantityMode === "fixed" ? v.quantityFixed : null,
  quantityFunctionId: v.quantityMode === "fixed" ? null : v.quantityFunctionId,
  quantityExtra: v.quantityMode === "fixed" ? 0 : v.quantityExtra,
  forWhom: v.forWhom,
  unitCostPaise: v.unitCostPaise,
  assigneeId: v.assigneeId,
  source: v.source,
  notes: v.notes,
});

export async function createGiftItem(db: Database, c: GiftCtx, input: GiftItemInput): Promise<GiftItem> {
  assertCan(c.subject, "gifts.manage");
  const v = parseInput(input);
  return db.transaction(async (tx) => {
    await checkRefs(tx, c.eventId, v);
    const [item] = await tx
      .insert(giftItems)
      .values({ eventId: c.eventId, ...fieldsOf(v), createdBy: c.actor.userId })
      .returning();
    if (v.householdIds?.length) await writeRecipients(tx, c.eventId, item.id, v.householdIds);
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift_item.created", entityType: "gift_item", entityId: item.id, data: { name: item.name } });
    return item;
  });
}

async function lockItem(tx: Tx, eventId: string, id: string) {
  const [item] = await tx
    .select()
    .from(giftItems)
    .where(and(eq(giftItems.id, id), eq(giftItems.eventId, eventId)))
    .for("update");
  if (!item) throw new GiftError("not_found");
  return item;
}

export async function updateGiftItem(db: Database, c: GiftCtx, id: string, version: number, input: GiftItemInput): Promise<GiftItem> {
  assertCan(c.subject, "gifts.manage");
  const v = parseInput(input);
  return db.transaction(async (tx) => {
    const old = await lockItem(tx, c.eventId, id);
    if (old.version !== version) throw new GiftError("stale");
    await checkRefs(tx, c.eventId, v);
    const fields = fieldsOf(v);
    // A new date gets a new "due soon" reminder.
    const moved = fields.functionId !== old.functionId || fields.giveBy !== old.giveBy;
    const needed = await neededOrNullTx(tx, c.eventId, fields);
    const status = autoStatus(old.status, old.quantityBought, needed);
    const [item] = await tx
      .update(giftItems)
      .set({ ...fields, status, remindedOn: moved ? null : old.remindedOn, version: old.version + 1, updatedAt: new Date() })
      .where(eq(giftItems.id, id))
      .returning();
    if (v.householdIds) await writeRecipients(tx, c.eventId, id, v.householdIds);
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift_item.updated", entityType: "gift_item", entityId: id, data: { name: item.name } });
    if (status !== old.status) await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift_item.status_changed", entityType: "gift_item", entityId: id, data: { name: item.name } });
    return item;
  });
}

async function neededOrNullTx(tx: Tx, eventId: string, item: QtyFields) {
  return neededOrNull(item, item.quantityMode === "fixed" ? new Map() : await invitedCounts(tx, eventId));
}

export async function deleteGiftItem(db: Database, c: GiftCtx, id: string) {
  assertCan(c.subject, "gifts.manage");
  await db.transaction(async (tx) => {
    const item = await lockItem(tx, c.eventId, id);
    await tx.delete(giftItems).where(eq(giftItems.id, id));
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift_item.deleted", entityType: "gift_item", entityId: id, data: { name: item.name } });
  });
}

/** Sets which families a gift is for (GFT-04). */
export async function setGiftRecipients(db: Database, c: GiftCtx, id: string, householdIds: string[]) {
  assertCan(c.subject, "gifts.manage");
  if (!z.array(z.string().uuid()).max(2000).safeParse(householdIds).success) throw new GiftError("invalid");
  await db.transaction(async (tx) => {
    const item = await lockItem(tx, c.eventId, id);
    await writeRecipients(tx, c.eventId, id, householdIds);
    await tx.update(giftItems).set({ version: item.version + 1, updatedAt: new Date() }).where(eq(giftItems.id, id));
  });
}

/**
 * Sets the purchase status (GFT-05). Marking it bought or given fills the bought count up to
 * what's needed, so the list and the summary agree.
 */
export async function setGiftStatus(db: Database, c: GiftCtx, id: string, status: GiftStatus): Promise<GiftItem> {
  assertCan(c.subject, "gifts.manage");
  if (!(GIFT_STATUSES as readonly string[]).includes(status)) throw new GiftError("invalid");
  return db.transaction(async (tx) => {
    const old = await lockItem(tx, c.eventId, id);
    let bought = old.quantityBought;
    if (status === "bought" || status === "given") {
      const needed = await neededOrNullTx(tx, c.eventId, old);
      if (needed !== null && bought < needed) bought = needed;
    }
    const [item] = await tx
      .update(giftItems)
      .set({ status, quantityBought: bought, version: old.version + 1, updatedAt: new Date() })
      .where(eq(giftItems.id, id))
      .returning();
    if (status !== old.status) await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift_item.status_changed", entityType: "gift_item", entityId: id, data: { name: item.name } });
    return item;
  });
}

export const markGiven = (db: Database, c: GiftCtx, id: string) => setGiftStatus(db, c, id, "given");

/**
 * Records how many are bought (GFT-05): either the new total (`set`) or a change (`add`, may be
 * negative). The count stays within 0..100,000; once it covers what's needed, "to buy" and
 * "ordered" become "bought". "Given" is never moved back.
 */
export async function recordBought(db: Database, c: GiftCtx, id: string, change: { set: number } | { add: number }): Promise<GiftItem> {
  assertCan(c.subject, "gifts.manage");
  const n = "set" in change ? change.set : change.add;
  if (!Number.isInteger(n) || Math.abs(n) > MAX_QTY) throw new GiftError("invalid");
  return db.transaction(async (tx) => {
    const old = await lockItem(tx, c.eventId, id);
    const bought = Math.max(0, Math.min(MAX_QTY, "set" in change ? change.set : old.quantityBought + change.add));
    const needed = await neededOrNullTx(tx, c.eventId, old);
    const status = autoStatus(old.status, bought, needed);
    const [item] = await tx
      .update(giftItems)
      .set({ quantityBought: bought, status, version: old.version + 1, updatedAt: new Date() })
      .where(eq(giftItems.id, id))
      .returning();
    if (status !== old.status) await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift_item.status_changed", entityType: "gift_item", entityId: id, data: { name: item.name } });
    return item;
  });
}

// ---------------------------------------------------------------------------
// Lists and summary (GFT-06)
// ---------------------------------------------------------------------------

export type GiftRow = GiftItem & {
  functionName: string | null;
  functionDate: string | null;
  quantityFunctionName: string | null;
  assigneeName: string | null;
  /** The day it's needed (earlier of give-by and the function's date). */
  when: string | null;
  /** null when a linked quantity has no function any more. */
  needed: number | null;
  remaining: number;
  /** unit cost × needed; null without a unit cost. */
  totalCostPaise: number | null;
  dueSoon: boolean;
  overdue: boolean;
  recipients: { id: string; name: string }[];
};

export const giftFilterKeys = ["q", "status", "category", "fn", "due", "mine"] as const;
export type GiftFilters = Partial<Record<(typeof giftFilterKeys)[number], string>>;

export function cleanGiftFilters(input: Record<string, unknown>): GiftFilters {
  const out: GiftFilters = {};
  for (const k of giftFilterKeys) {
    const v = input[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 60);
  }
  return out;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

async function eventToday(db: Tx, eventId: string, now: Date) {
  const [ev] = await db.select({ timezone: events.timezone }).from(events).where(eq(events.id, eventId));
  return todayIn(ev?.timezone ?? "Asia/Kolkata", now);
}

function toRow(
  r: { item: GiftItem; functionName: string | null; functionDate: string | null; quantityFunctionName: string | null; assigneeName: string | null },
  counts: Map<string, FunctionHeadcount>,
  today: string,
  recipients: { id: string; name: string }[],
): GiftRow {
  const needed = neededOrNull(r.item, counts);
  const when = whenDate(r.item.giveBy, r.functionDate);
  const open = stillToBuy(r.item.status, r.item.quantityBought, needed);
  return {
    ...r.item,
    functionName: r.functionName,
    functionDate: r.functionDate,
    quantityFunctionName: r.quantityFunctionName,
    assigneeName: r.assigneeName,
    when,
    needed,
    remaining: r.item.status === "given" || needed === null ? 0 : Math.max(0, needed - r.item.quantityBought),
    totalCostPaise: r.item.unitCostPaise === null || needed === null ? null : r.item.unitCostPaise * needed,
    dueSoon: open && !!when && when <= addDays(today, DUE_SOON_DAYS),
    overdue: open && !!when && when < today,
    recipients,
  };
}

const qtyFn = sql<string | null>`(select f.name from functions f where f.id = ${giftItems.quantityFunctionId})`;

function baseQuery(db: Tx) {
  return db
    .select({ item: giftItems, functionName: functions.name, functionDate: functions.date, quantityFunctionName: qtyFn, assigneeName: users.name })
    .from(giftItems)
    .leftJoin(functions, eq(functions.id, giftItems.functionId))
    .leftJoin(users, eq(users.id, giftItems.assigneeId))
    .$dynamic();
}

async function recipientsOf(db: Tx, ids: string[]) {
  if (ids.length === 0) return new Map<string, { id: string; name: string }[]>();
  const rows = await db
    .select({ giftItemId: giftItemRecipients.giftItemId, id: households.id, name: households.name })
    .from(giftItemRecipients)
    .innerJoin(households, eq(households.id, giftItemRecipients.householdId))
    .where(inArray(giftItemRecipients.giftItemId, ids))
    .orderBy(asc(households.name));
  const out = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) out.set(r.giftItemId, [...(out.get(r.giftItemId) ?? []), { id: r.id, name: r.name }]);
  return out;
}

/** Sort: by the day it's needed (undated last), then name. */
const byWhen = (a: GiftRow, b: GiftRow) => {
  if (a.when !== b.when) return a.when === null ? 1 : b.when === null ? -1 : a.when < b.when ? -1 : 1;
  return a.name.localeCompare(b.name);
};

export async function listGiftItems(db: Tx, c: GiftCtx, filters: GiftFilters = {}, now = new Date()): Promise<GiftRow[]> {
  assertCan(c.subject, "gifts.view");
  const conds: (SQL | undefined)[] = [eq(giftItems.eventId, c.eventId)];
  if (filters.status && (GIFT_STATUSES as readonly string[]).includes(filters.status)) conds.push(eq(giftItems.status, filters.status as GiftStatus));
  if (filters.category && (GIFT_CATEGORIES as readonly string[]).includes(filters.category)) conds.push(eq(giftItems.category, filters.category as GiftCategory));
  if (filters.fn === "none") conds.push(isNull(giftItems.functionId));
  else if (filters.fn && z.string().uuid().safeParse(filters.fn).success) conds.push(eq(giftItems.functionId, filters.fn));
  if (filters.mine === "1") conds.push(eq(giftItems.assigneeId, c.actor.userId));
  if (filters.due === "week") conds.push(ne(giftItems.status, "given"));
  if (filters.q) {
    const p = `%${escapeLike(filters.q)}%`;
    conds.push(or(ilike(giftItems.name, p), ilike(giftItems.forWhom, p)));
  }
  const [rows, counts, today] = await Promise.all([baseQuery(db).where(and(...conds)).limit(2000), invitedCounts(db, c.eventId), eventToday(db, c.eventId, now)]);
  const recips = await recipientsOf(
    db,
    rows.map((r) => r.item.id),
  );
  let out = rows.map((r) => toRow(r, counts, today, recips.get(r.item.id) ?? []));
  if (filters.due === "week") out = out.filter((r) => r.dueSoon);
  return out.sort(byWhen);
}

export async function getGiftItem(db: Tx, c: GiftCtx, id: string, now = new Date()): Promise<GiftRow> {
  assertCan(c.subject, "gifts.view");
  const [row] = await baseQuery(db).where(and(eq(giftItems.id, id), eq(giftItems.eventId, c.eventId)));
  if (!row) throw new GiftError("not_found");
  const [counts, today, recips] = await Promise.all([invitedCounts(db, c.eventId), eventToday(db, c.eventId, now), recipientsOf(db, [id])]);
  return toRow(row, counts, today, recips.get(id) ?? []);
}

export type GiftSummary = {
  items: number;
  /** Items fully bought or already given. */
  itemsDone: number;
  totalNeeded: number;
  totalBought: number;
  remaining: number;
  dueSoon: number;
  estimatedCostPaise: number;
};

export function summarise(rows: GiftRow[]): GiftSummary {
  const s: GiftSummary = { items: rows.length, itemsDone: 0, totalNeeded: 0, totalBought: 0, remaining: 0, dueSoon: 0, estimatedCostPaise: 0 };
  for (const r of rows) {
    if (!stillToBuy(r.status, r.quantityBought, r.needed)) s.itemsDone++;
    s.totalNeeded += r.needed ?? 0;
    s.totalBought += r.needed === null ? r.quantityBought : Math.min(r.quantityBought, r.needed);
    s.remaining += r.remaining;
    if (r.dueSoon) s.dueSoon++;
    s.estimatedCostPaise += r.totalCostPaise ?? 0;
  }
  return s;
}

/** Totals over the whole list (filters don't apply), for the summary card and dashboard. */
export async function giftSummary(db: Tx, c: GiftCtx, now = new Date()): Promise<GiftSummary> {
  return summarise(await listGiftItems(db, c, {}, now));
}

/** Families to choose as recipients (names only). */
export async function householdOptions(db: Tx, c: GiftCtx) {
  assertCan(c.subject, "gifts.view");
  return db.select({ id: households.id, name: households.name }).from(households).where(eq(households.eventId, c.eventId)).orderBy(asc(households.name)).limit(3000);
}

/** Team members who can be assigned to buy a gift. */
export async function assigneeOptions(db: Tx, c: GiftCtx) {
  assertCan(c.subject, "gifts.view");
  return db
    .select({ id: users.id, name: users.name })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .where(eq(eventMembers.eventId, c.eventId))
    .orderBy(asc(users.name));
}

// ---------------------------------------------------------------------------
// Daily reminder (GFT-06)
// ---------------------------------------------------------------------------

/**
 * Once per item: when it isn't fully bought and is needed within 7 days (or is overdue), its
 * assignee (or the Hosts, when nobody is assigned or the assignee left the team) is notified
 * in-app and by email. Moving the date re-arms the reminder.
 */
export async function sendGiftReminders(db: Database, now = new Date(), appUrl?: string): Promise<number> {
  const candidates = await db
    .select({ item: giftItems, functionDate: functions.date, timezone: events.timezone })
    .from(giftItems)
    .innerJoin(events, eq(events.id, giftItems.eventId))
    .leftJoin(functions, eq(functions.id, giftItems.functionId))
    .where(and(isNull(events.deletedAt), isNull(giftItems.remindedOn), ne(giftItems.status, "given")));
  const countsByEvent = new Map<string, Map<string, FunctionHeadcount>>();
  let sent = 0;
  for (const r of candidates) {
    const today = todayIn(r.timezone, now);
    const when = whenDate(r.item.giveBy, r.functionDate);
    if (!when || when > addDays(today, DUE_SOON_DAYS)) continue;
    let counts = countsByEvent.get(r.item.eventId);
    if (!counts) {
      counts = await invitedCounts(db, r.item.eventId);
      countsByEvent.set(r.item.eventId, counts);
    }
    if (!stillToBuy(r.item.status, r.item.quantityBought, neededOrNull(r.item, counts))) continue;
    const done = await db.transaction(async (tx) => {
      // Claim the item first, so two overlapping runs never notify twice.
      const claimed = await tx
        .update(giftItems)
        .set({ remindedOn: today })
        .where(and(eq(giftItems.id, r.item.id), isNull(giftItems.remindedOn)))
        .returning({ id: giftItems.id });
      if (claimed.length === 0) return false;
      const input = { kind: "gift.due", data: { name: r.item.name, date: when }, href: `/events/${r.item.eventId}/gifts`, appUrl };
      const [member] = r.item.assigneeId
        ? await tx
            .select({ userId: eventMembers.userId })
            .from(eventMembers)
            .where(and(eq(eventMembers.eventId, r.item.eventId), eq(eventMembers.userId, r.item.assigneeId)))
        : [];
      if (member) await notify(tx, { ...input, eventId: r.item.eventId, userIds: [member.userId] });
      else await notifyHosts(tx, r.item.eventId, input);
      return true;
    });
    if (done) sent++;
  }
  return sent;
}
