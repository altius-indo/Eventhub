import { and, eq, isNull } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { functions, giftImports, gifts, guests, households, type GiftImportRow } from "@/db/schema";
import { audit } from "./audit";
import { type GiftCtx } from "./gifts";
import { parseSpreadsheet } from "./guest-import";
import { normalizePhone } from "./guests";
import { rupeesToPaise } from "./money";
import { assertCan } from "./policy";

/**
 * Bulk import of post-event tally sheets (GFT-04): upload → rows matched to families → review
 * (match / free text / skip per row) → commit creates gifts with source "import".
 */

export const MAX_GIFT_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_GIFT_IMPORT_ROWS = 3000;

export class GiftImportError extends Error {
  constructor(public code: "unsupported" | "empty" | "too_large" | "too_many_rows" | "no_name_column" | "not_found" | "already_done" | "invalid") {
    super(code);
  }
}

type Column = "name" | "amount" | "item" | "envelope" | "function" | "phone";
const synonyms: Record<Column, string[]> = {
  name: ["name", "giver", "from", "guest", "guest name", "family", "family name", "नाम", "किसकी ओर से", "परिवार"],
  amount: ["amount", "shagun", "cash", "rs", "rs.", "₹", "inr", "value", "राशि", "शगुन", "रकम"],
  item: ["item", "gift", "gift item", "description", "उपहार", "सामान"],
  envelope: ["envelope", "envelope no", "envelope number", "lifafa", "no", "no.", "#", "लिफ़ाफ़ा", "लिफाफा"],
  function: ["function", "event", "ceremony", "कार्यक्रम", "रस्म"],
  phone: ["phone", "mobile", "contact", "whatsapp", "मोबाइल", "फ़ोन", "फोन"],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_*:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function guessGiftColumns(headers: string[]): Partial<Record<Column, number>> {
  const out: Partial<Record<Column, number>> = {};
  const used = new Set<number>();
  for (const col of Object.keys(synonyms) as Column[]) {
    const opts = synonyms[col];
    let i = headers.findIndex((h, k) => !used.has(k) && opts.includes(norm(h)));
    if (i < 0) i = headers.findIndex((h, k) => !used.has(k) && opts.some((o) => o.length > 3 && norm(h).includes(o)));
    if (i >= 0) {
      out[col] = i;
      used.add(i);
    }
  }
  return out;
}

type Candidate = { id: string; name: string; members: string[]; phones: string[] };

/** Case/space-insensitive exact name, then phone, then a unique "contains" match. */
export function matchHousehold(name: string, phone: string | null, list: Candidate[]): string | null {
  const n = norm(name);
  if (n) {
    const exact = list.filter((h) => norm(h.name) === n || h.members.some((m) => norm(m) === n));
    if (exact.length === 1) return exact[0].id;
  }
  if (phone) {
    const byPhone = list.filter((h) => h.phones.includes(phone));
    if (byPhone.length === 1) return byPhone[0].id;
  }
  if (n.length >= 3) {
    const partial = list.filter((h) => norm(h.name).includes(n) || n.includes(norm(h.name)) || h.members.some((m) => norm(m).includes(n)));
    if (partial.length === 1) return partial[0].id;
  }
  return null;
}

async function candidates(db: Tx, eventId: string): Promise<Candidate[]> {
  const rows = await db
    .select({ id: households.id, name: households.name, member: guests.name, phone: guests.phone })
    .from(households)
    .leftJoin(guests, eq(guests.householdId, households.id))
    .where(eq(households.eventId, eventId));
  const map = new Map<string, Candidate>();
  for (const r of rows) {
    const c = map.get(r.id) ?? { id: r.id, name: r.name, members: [], phones: [] };
    if (r.member) c.members.push(r.member);
    if (r.phone) c.phones.push(r.phone);
    map.set(r.id, c);
  }
  return [...map.values()];
}

/** Parses a sheet and stores the rows with a suggested decision each. */
export async function createGiftImport(db: Tx, c: GiftCtx, filename: string, data: ArrayBuffer) {
  assertCan(c.subject, "gifts.manage");
  if (data.byteLength > MAX_GIFT_IMPORT_BYTES) throw new GiftImportError("too_large");
  let parsed: { headers: string[]; rows: string[][] };
  try {
    parsed = await parseSpreadsheet(data, filename);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "unsupported" || code === "empty" || code === "too_large") throw new GiftImportError(code);
    if (code === "too_many_rows") throw new GiftImportError("too_many_rows");
    throw e;
  }
  if (parsed.rows.length > MAX_GIFT_IMPORT_ROWS) throw new GiftImportError("too_many_rows");
  const cols = guessGiftColumns(parsed.headers);
  if (cols.name === undefined) throw new GiftImportError("no_name_column");
  const fns = await db.select({ id: functions.id, name: functions.name }).from(functions).where(eq(functions.eventId, c.eventId));
  const list = await candidates(db, c.eventId);
  const cell = (r: string[], col: Column) => (cols[col] === undefined ? "" : (r[cols[col]!] ?? "").trim());
  const rows: GiftImportRow[] = parsed.rows.map((r) => {
    const raw = Object.fromEntries(parsed.headers.map((h, i) => [h, r[i] ?? ""]));
    const giverName = cell(r, "name").slice(0, 120);
    const amountText = cell(r, "amount");
    const amountPaise = amountText ? rupeesToPaise(amountText) : null;
    const item = cell(r, "item").slice(0, 300) || null;
    const fnText = norm(cell(r, "function"));
    const functionId = fnText ? (fns.find((f) => norm(f.name) === fnText)?.id ?? null) : null;
    const phone = normalizePhone(cell(r, "phone"));
    const householdId = giverName ? matchHousehold(giverName, phone && phone !== "invalid" ? phone : null, list) : null;
    let error: string | undefined;
    if (!giverName) error = "no_name";
    else if (amountText && amountPaise === null) error = "bad_amount";
    else if (!amountPaise && !item) error = "no_value";
    else if (fnText && !functionId) error = "unknown_function";
    return {
      raw,
      giverName,
      amountPaise: amountPaise ?? null,
      item,
      envelopeNo: cell(r, "envelope").slice(0, 20) || null,
      functionId,
      householdId,
      // An unknown function is only a warning: the gift is imported without one.
      decision: error && error !== "unknown_function" ? "skip" : householdId ? "match" : "free_text",
      error,
    };
  });
  const [imp] = await db.insert(giftImports).values({ eventId: c.eventId, createdBy: c.actor.userId, filename: filename.slice(0, 200), rows }).returning();
  return imp;
}

export async function getGiftImport(db: Tx, c: GiftCtx, importId: string) {
  assertCan(c.subject, "gifts.manage");
  const [imp] = await db
    .select()
    .from(giftImports)
    .where(and(eq(giftImports.id, importId), eq(giftImports.eventId, c.eventId)));
  if (!imp) throw new GiftImportError("not_found");
  return imp;
}

export type RowDecision = { index: number; decision: GiftImportRow["decision"]; householdId?: string | null };

/** Saves the review: per row match (to a family of this event), free text or skip. */
export async function reviewGiftImport(db: Database, c: GiftCtx, importId: string, decisions: RowDecision[]) {
  assertCan(c.subject, "gifts.manage");
  return db.transaction(async (tx) => {
    const [imp] = await tx
      .select()
      .from(giftImports)
      .where(and(eq(giftImports.id, importId), eq(giftImports.eventId, c.eventId)))
      .for("update");
    if (!imp) throw new GiftImportError("not_found");
    if (imp.committedAt) throw new GiftImportError("already_done");
    const ids = new Set((await tx.select({ id: households.id }).from(households).where(eq(households.eventId, c.eventId))).map((h) => h.id));
    const rows = [...imp.rows];
    for (const d of decisions) {
      const row = rows[d.index];
      if (!row) continue;
      const blocked = !!row.error && row.error !== "unknown_function";
      if (d.decision === "match") {
        const hid = d.householdId ?? row.householdId;
        if (!hid || !ids.has(hid) || blocked) throw new GiftImportError("invalid");
        rows[d.index] = { ...row, decision: "match", householdId: hid };
      } else if (d.decision === "free_text") {
        if (blocked) throw new GiftImportError("invalid");
        rows[d.index] = { ...row, decision: "free_text" };
      } else rows[d.index] = { ...row, decision: "skip" };
    }
    await tx.update(giftImports).set({ rows }).where(eq(giftImports.id, importId));
    return rows;
  });
}

/** Creates the gifts once (the import row is locked and stamped). */
export async function commitGiftImport(db: Database, c: GiftCtx, importId: string, today: string) {
  assertCan(c.subject, "gifts.manage");
  return db.transaction(async (tx) => {
    const [imp] = await tx
      .select()
      .from(giftImports)
      .where(and(eq(giftImports.id, importId), eq(giftImports.eventId, c.eventId), isNull(giftImports.committedAt)))
      .for("update");
    if (!imp) throw new GiftImportError("already_done");
    const ids = new Set((await tx.select({ id: households.id }).from(households).where(eq(households.eventId, c.eventId))).map((h) => h.id));
    const fnIds = new Set((await tx.select({ id: functions.id }).from(functions).where(eq(functions.eventId, c.eventId))).map((f) => f.id));
    const values = imp.rows
      .filter((r) => r.decision !== "skip" && (!r.error || r.error === "unknown_function"))
      .filter((r) => r.decision === "free_text" || (r.householdId && ids.has(r.householdId)))
      .map((r) => ({
        eventId: c.eventId,
        householdId: r.decision === "match" ? r.householdId : null,
        giverName: r.decision === "match" ? null : r.giverName,
        type: r.amountPaise ? ("cash" as const) : ("item" as const),
        amountPaise: r.amountPaise,
        itemDescription: r.amountPaise ? null : r.item,
        notes: r.amountPaise && r.item ? r.item : null,
        functionId: r.functionId && fnIds.has(r.functionId) ? r.functionId : null,
        envelopeNo: r.envelopeNo,
        receivedOn: today,
        recordedBy: c.actor.userId,
        source: "import" as const,
        importId,
      }));
    if (values.length) await tx.insert(gifts).values(values);
    await tx.update(giftImports).set({ committedAt: new Date() }).where(eq(giftImports.id, importId));
    await audit(tx, { eventId: c.eventId, actor: c.actor, action: "gift.imported", entityType: "gift_import", entityId: importId, data: { count: values.length, name: imp.filename } });
    return { created: values.length, skipped: imp.rows.length - values.length };
  });
}
