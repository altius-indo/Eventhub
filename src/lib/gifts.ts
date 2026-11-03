import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import { cashHandovers, eventMembers, events, functions, gifts, guests, households, thankYous, users, type Gift } from "@/db/schema";
import { formatInr } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import { notifyHosts } from "./notifications";
import { assertCan, can, ForbiddenError, type PolicySubject } from "./policy";
import { todayIn } from "./tasks";

/**
 * Gift register, envelope mode and cash reconciliation (GFT-01..05, GFT-07).
 *
 * Privacy is enforced here, not only in pages: Hosts and Planners with full gift access see
 * everything (`gifts.view`); Planners with record-only access (`gifts.record` without view) see
 * and change only the entries they recorded themselves and their own cash hand-overs.
 * Gifts are never part of the wedding budget.
 */

export class GiftError extends Error {
  constructor(
    public code:
      | "not_found"
      | "invalid"
      | "stale"
      | "no_giver"
      | "no_value"
      | "bad_household"
      | "bad_guest"
      | "bad_function"
      | "bad_member"
      | "handed_over"
      | "nothing_to_hand_over",
  ) {
    super(code);
  }
}

/** What the domain needs from the page/action: event, actor and their policy subject. */
export type GiftCtx = { eventId: string; actor: Actor; subject: PolicySubject };
export type GiftScope = "all" | "own";

/** Stored as the giver name when a family asks to be erased (EVT-09); shown translated. */
export const ERASED_GIVER = "—";

export const GIFT_TYPES = ["cash", "upi", "cheque", "item", "gold", "voucher", "other"] as const;
export const RECEIVED_FOR = ["bride", "groom", "couple", "parents", "other"] as const;
/** Gift types whose value is money (an amount is required). */
export const MONEY_TYPES: ReadonlySet<Gift["type"]> = new Set(["cash", "upi", "cheque"]);

/** "all" for Hosts / full access, "own" for record-only; anyone else is refused. */
export function giftScope(subject: PolicySubject): GiftScope {
  if (can(subject, "gifts.view")) return "all";
  if (can(subject, "gifts.record")) return "own";
  throw new ForbiddenError("gifts.record");
}

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
const paise = z.number().int().min(0).max(1e13).nullish().transform((v) => v ?? null);

export const giftInput = z
  .object({
    householdId: optUuid,
    guestId: optUuid,
    giverName: optText(120),
    type: z.enum(GIFT_TYPES),
    amountPaise: paise,
    itemDescription: optText(300),
    estValuePaise: paise,
    functionId: optUuid,
    receivedFor: z.enum(RECEIVED_FOR).default("couple"),
    receivedForNote: optText(120),
    envelopeNo: optText(20),
    receivedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish()
      .transform((v) => v ?? null),
    notes: optText(1000),
  })
  .superRefine((v, ctx) => {
    if (!v.householdId && !v.guestId && !v.giverName) ctx.addIssue({ code: "custom", message: "no_giver", path: ["giverName"] });
    if (MONEY_TYPES.has(v.type) ? !v.amountPaise : !v.amountPaise && !v.itemDescription && !v.estValuePaise)
      ctx.addIssue({ code: "custom", message: "no_value", path: ["amountPaise"] });
  });
export type GiftInput = z.input<typeof giftInput>;
type GiftValues = z.output<typeof giftInput>;

function parseInput(input: GiftInput): GiftValues {
  const r = giftInput.safeParse(input);
  if (r.success) return r.data;
  const msg = r.error.issues[0]?.message;
  throw new GiftError(msg === "no_giver" || msg === "no_value" ? msg : "invalid");
}

/** Normalises the value fields: money types keep an amount, items keep a description. */
function valueFields(v: GiftValues) {
  const money = MONEY_TYPES.has(v.type);
  return {
    amountPaise: v.amountPaise,
    itemDescription: money ? null : v.itemDescription,
    estValuePaise: money ? null : v.estValuePaise,
  };
}

/** Checks the giver and function belong to this event; a guest implies their household. */
async function resolveRefs(tx: Tx, eventId: string, v: { householdId: string | null; guestId: string | null; functionId: string | null }) {
  let householdId = v.householdId;
  if (v.guestId) {
    const [g] = await tx.select({ householdId: guests.householdId }).from(guests).where(and(eq(guests.id, v.guestId), eq(guests.eventId, eventId)));
    if (!g || (householdId && g.householdId !== householdId)) throw new GiftError("bad_guest");
    householdId = g.householdId;
  }
  let householdName: string | null = null;
  if (householdId) {
    const [h] = await tx.select({ name: households.name }).from(households).where(and(eq(households.id, householdId), eq(households.eventId, eventId)));
    if (!h) throw new GiftError("bad_household");
    householdName = h.name;
  }
  let functionName: string | null = null;
  if (v.functionId) {
    const [f] = await tx.select({ name: functions.name }).from(functions).where(and(eq(functions.id, v.functionId), eq(functions.eventId, eventId)));
    if (!f) throw new GiftError("bad_function");
    functionName = f.name;
  }
  return { householdId, guestId: v.guestId, householdName, functionName };
}

/** Same envelope number already used in this function (a warning, never an error). */
async function envelopeTaken(tx: Tx, eventId: string, functionId: string | null, envelopeNo: string | null, exceptId?: string) {
  if (!envelopeNo) return false;
  const [row] = await tx
    .select({ id: gifts.id })
    .from(gifts)
    .where(
      and(
        eq(gifts.eventId, eventId),
        functionId ? eq(gifts.functionId, functionId) : isNull(gifts.functionId),
        sql`lower(${gifts.envelopeNo}) = lower(${envelopeNo})`,
        exceptId ? sql`${gifts.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return !!row;
}

const ownOnly = (scope: GiftScope, actor: Actor) => (scope === "own" ? eq(gifts.recordedBy, actor.userId) : undefined);

async function loadForChange(tx: Tx, c: GiftCtx, giftId: string, scope: GiftScope) {
  const [g] = await tx
    .select()
    .from(gifts)
    .where(and(eq(gifts.id, giftId), eq(gifts.eventId, c.eventId), ownOnly(scope, c.actor)))
    .for("update");
  // Someone else's entry looks exactly like a missing one to a record-only user.
  if (!g) throw new GiftError("not_found");
  // Record-only collectors can't change cash that has already been handed over.
  if (scope === "own" && g.handoverId) throw new GiftError("handed_over");
  return g;
}

// ---------------------------------------------------------------------------
// Register (GFT-01)
// ---------------------------------------------------------------------------

export async function createGift(db: Database, c: GiftCtx, input: GiftInput): Promise<{ gift: Gift; duplicateEnvelope: boolean }> {
  giftScope(c.subject);
  const v = parseInput(input);
  return db.transaction(async (tx) => {
    const refs = await resolveRefs(tx, c.eventId, v);
    const duplicateEnvelope = await envelopeTaken(tx, c.eventId, v.functionId, v.envelopeNo);
    const [gift] = await tx
      .insert(gifts)
      .values({
        eventId: c.eventId,
        householdId: refs.householdId,
        guestId: refs.guestId,
        giverName: refs.householdId ? null : v.giverName,
        type: v.type,
        ...valueFields(v),
        functionId: v.functionId,
        receivedFor: v.receivedFor,
        receivedForNote: v.receivedFor === "other" ? v.receivedForNote : null,
        envelopeNo: v.envelopeNo,
        receivedOn: v.receivedOn,
        notes: v.notes,
        recordedBy: c.actor.userId,
        source: "manual",
      })
      .returning();
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift.recorded", entityType: "gift", entityId: gift.id, data: { name: refs.householdName ?? v.giverName ?? "" } });
    return { gift, duplicateEnvelope };
  });
}

export async function updateGift(db: Database, c: GiftCtx, giftId: string, version: number, input: GiftInput): Promise<{ gift: Gift; duplicateEnvelope: boolean }> {
  const scope = giftScope(c.subject);
  const v = parseInput(input);
  return db.transaction(async (tx) => {
    const old = await loadForChange(tx, c, giftId, scope);
    if (old.version !== version) throw new GiftError("stale");
    const refs = await resolveRefs(tx, c.eventId, v);
    const duplicateEnvelope = await envelopeTaken(tx, c.eventId, v.functionId, v.envelopeNo, giftId);
    const [gift] = await tx
      .update(gifts)
      .set({
        householdId: refs.householdId,
        guestId: refs.guestId,
        giverName: refs.householdId ? null : v.giverName,
        type: v.type,
        ...valueFields(v),
        functionId: v.functionId,
        receivedFor: v.receivedFor,
        receivedForNote: v.receivedFor === "other" ? v.receivedForNote : null,
        envelopeNo: v.envelopeNo,
        receivedOn: v.receivedOn,
        notes: v.notes,
        version: old.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(gifts.id, giftId))
      .returning();
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift.updated", entityType: "gift", entityId: gift.id, data: { name: refs.householdName ?? v.giverName ?? "" } });
    return { gift, duplicateEnvelope };
  });
}

export async function deleteGift(db: Database, c: GiftCtx, giftId: string) {
  const scope = giftScope(c.subject);
  await db.transaction(async (tx) => {
    const g = await loadForChange(tx, c, giftId, scope);
    const [h] = g.householdId ? await tx.select({ name: households.name }).from(households).where(eq(households.id, g.householdId)) : [];
    await tx.delete(gifts).where(eq(gifts.id, giftId));
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift.deleted", entityType: "gift", entityId: giftId, data: { name: h?.name ?? g.giverName ?? "" } });
  });
}

export type GiftRow = Gift & { householdName: string | null; functionName: string | null; recordedByName: string | null; handedOver: boolean };

export async function getGift(db: Tx, c: GiftCtx, giftId: string): Promise<GiftRow> {
  const scope = giftScope(c.subject);
  const [row] = await baseQuery(db).where(and(eq(gifts.id, giftId), eq(gifts.eventId, c.eventId), ownOnly(scope, c.actor)));
  if (!row) throw new GiftError("not_found");
  return toRow(row);
}

function baseQuery(db: Tx) {
  return db
    .select({ gift: gifts, householdName: households.name, functionName: functions.name, recordedByName: users.name })
    .from(gifts)
    .leftJoin(households, eq(households.id, gifts.householdId))
    .leftJoin(functions, eq(functions.id, gifts.functionId))
    .leftJoin(users, eq(users.id, gifts.recordedBy))
    .$dynamic();
}
const toRow = (r: { gift: Gift; householdName: string | null; functionName: string | null; recordedByName: string | null }): GiftRow => ({
  ...r.gift,
  householdName: r.householdName,
  functionName: r.functionName,
  recordedByName: r.recordedByName,
  handedOver: !!r.gift.handoverId,
});

export const giftFilterKeys = ["q", "fn", "type", "for", "source"] as const;
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

export async function listGifts(db: Tx, c: GiftCtx, filters: GiftFilters = {}, limit = 500): Promise<GiftRow[]> {
  const scope = giftScope(c.subject);
  const conds: (SQL | undefined)[] = [eq(gifts.eventId, c.eventId), ownOnly(scope, c.actor)];
  if (filters.fn === "none") conds.push(isNull(gifts.functionId));
  else if (filters.fn && z.string().uuid().safeParse(filters.fn).success) conds.push(eq(gifts.functionId, filters.fn));
  if (filters.type && (GIFT_TYPES as readonly string[]).includes(filters.type)) conds.push(eq(gifts.type, filters.type as Gift["type"]));
  if (filters.for && (RECEIVED_FOR as readonly string[]).includes(filters.for)) conds.push(eq(gifts.receivedFor, filters.for as Gift["receivedFor"]));
  if (filters.source && ["manual", "envelope", "import"].includes(filters.source)) conds.push(eq(gifts.source, filters.source as Gift["source"]));
  if (filters.q) {
    const p = `%${escapeLike(filters.q)}%`;
    conds.push(or(ilike(households.name, p), ilike(gifts.giverName, p), ilike(gifts.envelopeNo, p), ilike(gifts.itemDescription, p)));
  }
  const rows = await baseQuery(db)
    .where(and(...conds))
    .orderBy(desc(gifts.createdAt), desc(gifts.id))
    .limit(Math.min(limit, 2000));
  return rows.map(toRow);
}

// ---------------------------------------------------------------------------
// Envelope mode (GFT-02): idempotent batches from an offline queue
// ---------------------------------------------------------------------------

export const envelopeItem = z.object({
  clientKey: z.string().uuid(),
  householdId: optUuid,
  guestId: optUuid,
  giverName: optText(120),
  type: z.enum(GIFT_TYPES).default("cash"),
  amountPaise: paise,
  itemDescription: optText(300),
  envelopeNo: optText(20),
  receivedFor: z.enum(RECEIVED_FOR).default("couple"),
  at: z.string().datetime().optional(),
});
export type EnvelopeItem = z.input<typeof envelopeItem>;

/**
 * The day an envelope was received, in the event's timezone: the device's `at` (entries queued
 * offline sync later), unless it is more than 5 minutes ahead of the server or older than 7 days
 * (a wrong device clock), in which case the sync time is used.
 */
export function envelopeDate(at: string | undefined, now: Date, timeZone: string): string {
  const t = at ? new Date(at) : null;
  const ok = t && !Number.isNaN(t.getTime()) && t.getTime() <= now.getTime() + 5 * 60_000 && t.getTime() >= now.getTime() - 7 * 86_400_000;
  return todayIn(timeZone, ok ? t : now);
}
export type EnvelopeRejectCode = "invalid" | "no_giver" | "no_value" | "bad_household" | "bad_guest";
export type EnvelopeResult = {
  created: string[];
  existing: string[];
  rejected: { clientKey: string; code: EnvelopeRejectCode }[];
  duplicateEnvelopes: { clientKey: string; envelopeNo: string }[];
};

/**
 * Stores envelope entries. Each carries a client-made key, so retries and a second sync from
 * the same queue are stored once (insert … on conflict do nothing). One bad entry is reported
 * on its own and never makes the desk lose the rest of the batch.
 */
export async function recordEnvelopes(db: Database, c: GiftCtx, functionId: string, items: EnvelopeItem[], now = new Date()): Promise<EnvelopeResult> {
  giftScope(c.subject);
  const out: EnvelopeResult = { created: [], existing: [], rejected: [], duplicateEnvelopes: [] };
  if (items.length === 0) return out;
  return db.transaction(async (tx) => {
    const [fn] = await tx.select({ name: functions.name }).from(functions).where(and(eq(functions.id, functionId), eq(functions.eventId, c.eventId)));
    if (!fn) throw new GiftError("bad_function");
    const seen = new Set<string>();
    const [ev] = await tx.select({ timezone: events.timezone }).from(events).where(eq(events.id, c.eventId));
    const timeZone = ev?.timezone ?? "Asia/Kolkata";
    for (const raw of items) {
      const parsed = envelopeItem.safeParse(raw);
      const key = typeof (raw as { clientKey?: unknown }).clientKey === "string" ? (raw as { clientKey: string }).clientKey : "";
      if (!parsed.success) {
        out.rejected.push({ clientKey: key, code: "invalid" });
        continue;
      }
      const it = parsed.data;
      if (seen.has(it.clientKey)) continue;
      seen.add(it.clientKey);
      if (!it.householdId && !it.guestId && !it.giverName) {
        out.rejected.push({ clientKey: it.clientKey, code: "no_giver" });
        continue;
      }
      if (MONEY_TYPES.has(it.type) ? !it.amountPaise : !it.amountPaise && !it.itemDescription) {
        out.rejected.push({ clientKey: it.clientKey, code: "no_value" });
        continue;
      }
      let refs;
      try {
        refs = await resolveRefs(tx, c.eventId, { householdId: it.householdId, guestId: it.guestId, functionId: null });
      } catch (e) {
        if (e instanceof GiftError && (e.code === "bad_household" || e.code === "bad_guest")) {
          out.rejected.push({ clientKey: it.clientKey, code: e.code });
          continue;
        }
        throw e;
      }
      const dup = await envelopeTaken(tx, c.eventId, functionId, it.envelopeNo);
      const money = MONEY_TYPES.has(it.type);
      const inserted = await tx
        .insert(gifts)
        .values({
          eventId: c.eventId,
          householdId: refs.householdId,
          guestId: refs.guestId,
          giverName: refs.householdId ? null : it.giverName,
          type: it.type,
          amountPaise: it.amountPaise,
          itemDescription: money ? null : it.itemDescription,
          functionId,
          receivedFor: it.receivedFor,
          envelopeNo: it.envelopeNo,
          receivedOn: envelopeDate(it.at, now, timeZone),
          recordedBy: c.actor.userId,
          source: "envelope",
          clientKey: it.clientKey,
        })
        .onConflictDoNothing()
        .returning({ id: gifts.id });
      if (inserted.length === 0) {
        out.existing.push(it.clientKey);
        continue;
      }
      out.created.push(it.clientKey);
      if (dup && it.envelopeNo) out.duplicateEnvelopes.push({ clientKey: it.clientKey, envelopeNo: it.envelopeNo });
    }
    if (out.created.length) {
      await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift.envelopes_recorded", entityType: "function", entityId: functionId, data: { count: out.created.length, function: fn.name } });
    }
    return out;
  });
}

/** The collector's own latest entries at a function (for the envelope desk). */
export async function myRecentEnvelopes(db: Tx, c: GiftCtx, functionId: string, limit = 10) {
  giftScope(c.subject);
  return db
    .select({
      id: gifts.id,
      clientKey: gifts.clientKey,
      householdName: households.name,
      giverName: gifts.giverName,
      type: gifts.type,
      amountPaise: gifts.amountPaise,
      itemDescription: gifts.itemDescription,
      envelopeNo: gifts.envelopeNo,
      createdAt: gifts.createdAt,
    })
    .from(gifts)
    .leftJoin(households, eq(households.id, gifts.householdId))
    .where(and(eq(gifts.eventId, c.eventId), eq(gifts.functionId, functionId), eq(gifts.recordedBy, c.actor.userId)))
    .orderBy(desc(gifts.createdAt))
    .limit(limit);
}

/** Families to pick in envelope mode: name search over families and members (no contact data). */
export async function searchGivers(db: Tx, c: GiftCtx, q: string) {
  giftScope(c.subject);
  const query = q.trim().slice(0, 60);
  if (query.length < 2) return [];
  const p = `%${escapeLike(query)}%`;
  const digits = query.replace(/\D/g, "");
  const rows = await db
    .selectDistinct({ id: households.id, name: households.name, side: households.side })
    .from(households)
    .leftJoin(guests, eq(guests.householdId, households.id))
    .where(
      and(
        eq(households.eventId, c.eventId),
        or(ilike(households.name, p), ilike(guests.name, p), digits.length >= 4 ? sql`${guests.phone} like ${`%${digits}`}` : undefined),
      ),
    )
    .orderBy(asc(households.name))
    .limit(15);
  if (rows.length === 0) return [];
  const members = await db
    .select({ householdId: guests.householdId, name: guests.name })
    .from(guests)
    .where(
      inArray(
        guests.householdId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(guests.sortOrder));
  return rows.map((r) => ({ ...r, members: members.filter((m) => m.householdId === r.id).map((m) => m.name) }));
}

// ---------------------------------------------------------------------------
// Cash reconciliation (GFT-03)
// ---------------------------------------------------------------------------

export type OpenCash = { functionId: string | null; functionName: string | null; collectorUserId: string | null; collectorName: string | null; count: number; totalPaise: number };
export type HandoverRow = {
  id: string;
  functionId: string | null;
  functionName: string | null;
  collectorUserId: string | null;
  collectorName: string | null;
  recordedTotalPaise: number;
  countedPaise: number;
  /** What the gifts in this hand-over add up to now; differs when one was edited afterwards. */
  currentTotalPaise: number;
  handedToName: string | null;
  handedAt: Date;
  notes: string | null;
};

/** Imported tally sheets are records after the fact, not cash someone is holding. */
const notImported = sql`${gifts.source} <> 'import'`;
const fnMatch = (functionId: string | null) => (functionId ? eq(gifts.functionId, functionId) : isNull(gifts.functionId));

/** Cash gifts not yet handed over, per function and collector. Record-only users see their own. */
export async function openCash(db: Tx, c: GiftCtx): Promise<OpenCash[]> {
  const scope = giftScope(c.subject);
  const rows = await db
    .select({
      functionId: gifts.functionId,
      functionName: functions.name,
      collectorUserId: gifts.recordedBy,
      collectorName: users.name,
      count: sql<number>`count(*)::int`,
      totalPaise: sql<number>`coalesce(sum(${gifts.amountPaise}), 0)::bigint`.mapWith(Number),
    })
    .from(gifts)
    .leftJoin(functions, eq(functions.id, gifts.functionId))
    .leftJoin(users, eq(users.id, gifts.recordedBy))
    .where(and(eq(gifts.eventId, c.eventId), eq(gifts.type, "cash"), isNull(gifts.handoverId), notImported, ownOnly(scope, c.actor)))
    .groupBy(gifts.functionId, functions.name, functions.date, gifts.recordedBy, users.name)
    .orderBy(asc(functions.date), asc(functions.name), asc(users.name));
  return rows;
}

export async function listHandovers(db: Tx, c: GiftCtx): Promise<HandoverRow[]> {
  const scope = giftScope(c.subject);
  const collector = sql<string | null>`(select name from users where id = ${cashHandovers.collectorUserId})`;
  const handedTo = sql<string | null>`coalesce(${cashHandovers.handedToName}, (select name from users where id = ${cashHandovers.handedToUserId}))`;
  const current = sql<number>`(select coalesce(sum(g.amount_paise), 0) from gifts g where g.handover_id = ${cashHandovers.id} and g.type = 'cash')::bigint`.mapWith(Number);
  return db
    .select({
      id: cashHandovers.id,
      functionId: cashHandovers.functionId,
      functionName: functions.name,
      collectorUserId: cashHandovers.collectorUserId,
      collectorName: collector,
      recordedTotalPaise: cashHandovers.recordedTotalPaise,
      countedPaise: cashHandovers.countedPaise,
      currentTotalPaise: current,
      handedToName: handedTo,
      handedAt: cashHandovers.handedAt,
      notes: cashHandovers.notes,
    })
    .from(cashHandovers)
    .leftJoin(functions, eq(functions.id, cashHandovers.functionId))
    .where(and(eq(cashHandovers.eventId, c.eventId), scope === "own" ? eq(cashHandovers.collectorUserId, c.actor.userId) : undefined))
    .orderBy(desc(cashHandovers.handedAt));
}

export const handoverInput = z
  .object({
    functionId: optUuid,
    collectorUserId: z.string().uuid(),
    countedPaise: z.number().int().min(0).max(1e13),
    handedToUserId: optUuid,
    handedToName: optText(120),
    handedAt: z.date().optional(),
    notes: optText(500),
  })
  .refine((v) => v.handedToUserId || v.handedToName, { message: "no_receiver" });
export type HandoverInput = z.input<typeof handoverInput>;

/**
 * Records a hand-over: snapshots the collector's cash gifts at that function that aren't handed
 * over yet (locked, so an entry synced meanwhile goes to the next hand-over) and flags any
 * difference with the counted cash to the Hosts.
 */
export async function createHandover(db: Database, c: GiftCtx, input: HandoverInput) {
  const scope = giftScope(c.subject);
  const r = handoverInput.safeParse(input);
  if (!r.success) throw new GiftError("invalid");
  const v = r.data;
  if (scope === "own" && v.collectorUserId !== c.actor.userId) throw new GiftError("not_found");
  return db.transaction(async (tx) => {
    let functionName: string | null = null;
    if (v.functionId) {
      const [f] = await tx.select({ name: functions.name }).from(functions).where(and(eq(functions.id, v.functionId), eq(functions.eventId, c.eventId)));
      if (!f) throw new GiftError("bad_function");
      functionName = f.name;
    }
    // The collector must be on the team of this event, like the person it's handed to.
    const [collector] = await tx.select({ id: eventMembers.id }).from(eventMembers).where(and(eq(eventMembers.eventId, c.eventId), eq(eventMembers.userId, v.collectorUserId)));
    if (!collector) throw new GiftError("bad_member");
    if (v.handedToUserId) {
      const [m] = await tx.select({ id: eventMembers.id }).from(eventMembers).where(and(eq(eventMembers.eventId, c.eventId), eq(eventMembers.userId, v.handedToUserId)));
      if (!m) throw new GiftError("bad_member");
    }
    const open = await tx
      .select({ id: gifts.id, amountPaise: gifts.amountPaise })
      .from(gifts)
      .where(and(eq(gifts.eventId, c.eventId), fnMatch(v.functionId), eq(gifts.recordedBy, v.collectorUserId), eq(gifts.type, "cash"), isNull(gifts.handoverId), notImported))
      .for("update");
    const recorded = open.reduce((a, g) => a + (g.amountPaise ?? 0), 0);
    if (open.length === 0 && v.countedPaise === 0) throw new GiftError("nothing_to_hand_over");
    const [h] = await tx
      .insert(cashHandovers)
      .values({
        eventId: c.eventId,
        functionId: v.functionId,
        collectorUserId: v.collectorUserId,
        recordedTotalPaise: recorded,
        countedPaise: v.countedPaise,
        handedToUserId: v.handedToUserId,
        handedToName: v.handedToUserId ? null : v.handedToName,
        handedAt: v.handedAt ?? new Date(),
        notes: v.notes,
        createdBy: c.actor.userId,
      })
      .returning();
    if (open.length) {
      await tx
        .update(gifts)
        .set({ handoverId: h.id })
        .where(
          inArray(
            gifts.id,
            open.map((g) => g.id),
          ),
        );
    }
    const diff = v.countedPaise - recorded;
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: diff === 0 ? "gift.handover" : "gift.handover_discrepancy", entityType: "cash_handover", entityId: h.id, data: { function: functionName ?? "" } });
    if (diff !== 0) {
      // Hosts only: the amount never goes to anyone without gift access.
      // In-app only: shagun amounts never go out by email (GFT-07).
      await notifyHosts(tx, c.eventId, {
        kind: "gift.handover_discrepancy",
        noEmail: true,
        data: { function: functionName ?? "—", amount: `${diff < 0 ? "−" : "+"}${formatInr("en", Math.abs(diff))}` },
        href: `/events/${c.eventId}/gifts/cash`,
      });
    }
    return { handover: h, discrepancyPaise: diff, count: open.length };
  });
}

/** Members who can receive or collect cash (for the hand-over form). */
export async function giftMembers(db: Tx, c: GiftCtx) {
  giftScope(c.subject);
  return db
    .select({ userId: eventMembers.userId, name: users.name, role: eventMembers.role, giftAccess: eventMembers.giftAccess })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .where(eq(eventMembers.eventId, c.eventId))
    .orderBy(asc(users.name));
}

// ---------------------------------------------------------------------------
// Summaries (GFT-05). Full access only.
// ---------------------------------------------------------------------------

export type GiftTotals = { key: string | null; label: string | null; count: number; amountPaise: number; estValuePaise: number };

export async function giftSummary(db: Tx, c: GiftCtx) {
  assertCan(c.subject, "gifts.view");
  const amount = sql<number>`coalesce(sum(${gifts.amountPaise}), 0)::bigint`.mapWith(Number);
  const est = sql<number>`coalesce(sum(${gifts.estValuePaise}), 0)::bigint`.mapWith(Number);
  const n = sql<number>`count(*)::int`;
  const where = eq(gifts.eventId, c.eventId);
  const [byFunction, byFor, byType, [total]] = await Promise.all([
    db
      .select({ key: gifts.functionId, label: functions.name, count: n, amountPaise: amount, estValuePaise: est })
      .from(gifts)
      .leftJoin(functions, eq(functions.id, gifts.functionId))
      .where(where)
      .groupBy(gifts.functionId, functions.name, functions.date)
      .orderBy(asc(functions.date)),
    db.select({ key: gifts.receivedFor, count: n, amountPaise: amount, estValuePaise: est }).from(gifts).where(where).groupBy(gifts.receivedFor),
    db.select({ key: gifts.type, count: n, amountPaise: amount, estValuePaise: est }).from(gifts).where(where).groupBy(gifts.type),
    db.select({ count: n, amountPaise: amount, estValuePaise: est }).from(gifts).where(where),
  ]);
  return {
    byFunction: byFunction as GiftTotals[],
    byReceivedFor: byFor.map((r) => ({ ...r, label: null })) as GiftTotals[],
    byType: byType.map((r) => ({ ...r, label: null })) as GiftTotals[],
    total,
  };
}

/** Families with no gift recorded (for follow-up or data-entry checks), with whether they attended. */
export async function householdsWithoutGift(db: Tx, c: GiftCtx, limit = 500) {
  assertCan(c.subject, "gifts.view");
  return db
    .select({
      id: households.id,
      name: households.name,
      side: households.side,
      attended: sql<boolean>`exists (select 1 from check_ins ci join guests g on g.id = ci.guest_id where g.household_id = "households"."id")`,
    })
    .from(households)
    .where(and(eq(households.eventId, c.eventId), sql`not exists (select 1 from gifts gx where gx.household_id = "households"."id")`))
    .orderBy(asc(households.name))
    .limit(limit);
}

/** Share of families thanked (GFT-10): sent / (all families except "not needed"). */
export async function thankedStats(db: Tx, eventId: string) {
  const [r] = await db
    .select({
      total: sql<number>`count(*)::int`,
      sent: sql<number>`count(*) filter (where ${thankYous.status} = 'sent')::int`,
      notNeeded: sql<number>`count(*) filter (where ${thankYous.status} = 'not_needed')::int`,
      drafted: sql<number>`count(*) filter (where ${thankYous.status} = 'drafted')::int`,
    })
    .from(households)
    .leftJoin(thankYous, eq(thankYous.householdId, households.id))
    .where(eq(households.eventId, eventId));
  const base = r.total - r.notNeeded;
  return { ...r, pct: base > 0 ? Math.round((r.sent / base) * 100) : 0 };
}

// ---------------------------------------------------------------------------
// Erasure (EVT-09)
// ---------------------------------------------------------------------------

/**
 * Before a family is deleted: their gifts stay (so reconciliation still adds up) but lose the
 * link and the name. The foreign keys then null household/guest ids.
 */
export async function anonymiseGiftsOfHousehold(tx: Tx, eventId: string, householdId: string) {
  await tx
    .update(gifts)
    .set({ giverName: ERASED_GIVER, receivedForNote: null, notes: null, updatedAt: new Date() })
    .where(and(eq(gifts.eventId, eventId), eq(gifts.householdId, householdId)));
}

/** How a giver shows in lists: family name, free-text name, or the erased placeholder. */
export function giverLabel(g: { householdName: string | null; giverName: string | null }, erased: string) {
  if (g.householdName) return g.householdName;
  if (!g.giverName || g.giverName === ERASED_GIVER) return erased;
  return g.giverName;
}

/** Families to choose as the giver (names only). */
export async function householdOptions(db: Tx, c: GiftCtx) {
  giftScope(c.subject);
  return db.select({ id: households.id, name: households.name }).from(households).where(eq(households.eventId, c.eventId)).orderBy(asc(households.name)).limit(3000);
}

/** The collector's own cash at a function that hasn't been handed over yet. */
export async function myOpenCash(db: Tx, c: GiftCtx, functionId: string) {
  giftScope(c.subject);
  const [r] = await db
    .select({ count: sql<number>`count(*)::int`, totalPaise: sql<number>`coalesce(sum(${gifts.amountPaise}), 0)::bigint`.mapWith(Number) })
    .from(gifts)
    .where(and(eq(gifts.eventId, c.eventId), eq(gifts.functionId, functionId), eq(gifts.recordedBy, c.actor.userId), eq(gifts.type, "cash"), isNull(gifts.handoverId), notImported));
  return r;
}
