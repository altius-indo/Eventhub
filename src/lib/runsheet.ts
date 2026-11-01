import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import { eventMembers, functions, runSheetItems, runItemStatus, users, vendors, type RunItemStatus, type RunSheetItem } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { normalizePhone } from "./guests";
import { addMinutes, parseWallClock } from "./wall-clock";

export class RunSheetError extends Error {
  constructor(public code: "not_found" | "bad_owner" | "bad_function" | "phone_invalid" | "invalid") {
    super(code);
  }
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);

export const itemSchema = z.object({
  startsAt: z.string().transform((v, ctx) => {
    const d = parseWallClock(v);
    if (!d) ctx.addIssue({ code: "custom", message: "startsAt" });
    return d as Date;
  }),
  durationMin: z
    .union([z.literal(""), z.coerce.number().int().min(1).max(24 * 60)])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  title: z.string().trim().min(1).max(200),
  ownerUserId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  /** A vendor from the directory; the item then shows in their portal (VND-10). */
  ownerVendorId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  ownerName: text(120),
  ownerPhone: text(30),
  location: text(160),
  notes: text(2000),
  timeLocked: z.boolean().default(false),
});
export type ItemInput = z.infer<typeof itemSchema>;

async function validate(tx: Tx, eventId: string, functionId: string, input: ItemInput): Promise<ItemInput> {
  const [f] = await tx.select({ id: functions.id }).from(functions).where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)));
  if (!f) throw new RunSheetError("bad_function");
  if (input.ownerUserId) {
    const [m] = await tx
      .select({ id: eventMembers.id })
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, input.ownerUserId)));
    if (!m) throw new RunSheetError("bad_owner");
  }
  if (input.ownerVendorId) {
    const [v] = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.id, input.ownerVendorId), eq(vendors.eventId, eventId), isNull(vendors.archivedAt)));
    if (!v) throw new RunSheetError("bad_owner");
  }
  let ownerPhone = input.ownerPhone;
  if (ownerPhone) {
    const p = normalizePhone(ownerPhone);
    if (p === "invalid") throw new RunSheetError("phone_invalid");
    ownerPhone = p;
  }
  return { ...input, ownerPhone };
}

export async function createItem(db: Database, eventId: string, functionId: string, input: ItemInput) {
  return db.transaction(async (tx) => {
    const data = await validate(tx, eventId, functionId, input);
    const [item] = await tx.insert(runSheetItems).values({ eventId, functionId, ...data }).returning();
    return item;
  });
}

export async function updateItem(db: Database, eventId: string, itemId: string, input: ItemInput) {
  return db.transaction(async (tx) => {
    const existing = await getItem(tx, eventId, itemId);
    const data = await validate(tx, eventId, existing.functionId, input);
    const [item] = await tx.update(runSheetItems).set({ ...data, updatedAt: new Date() }).where(eq(runSheetItems.id, itemId)).returning();
    return item;
  });
}

export async function getItem(db: Tx, eventId: string, itemId: string) {
  const [item] = await db.select().from(runSheetItems).where(and(eq(runSheetItems.id, itemId), eq(runSheetItems.eventId, eventId)));
  if (!item) throw new RunSheetError("not_found");
  return item;
}

export async function deleteItem(db: Database, eventId: string, itemId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .delete(runSheetItems)
      .where(and(eq(runSheetItems.id, itemId), eq(runSheetItems.eventId, eventId)))
      .returning();
    if (!item) throw new RunSheetError("not_found");
    await audit(tx, { eventId, actor, action: "runsheet.item_deleted", entityType: "run_sheet_item", entityId: itemId, data: { title: item.title } });
  });
}

export async function setItemStatus(db: Database, eventId: string, itemId: string, status: RunItemStatus) {
  const [item] = await db
    .update(runSheetItems)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(runSheetItems.id, itemId), eq(runSheetItems.eventId, eventId)))
    .returning();
  if (!item) throw new RunSheetError("not_found");
  return item;
}

/**
 * "Running late": moves this item and every not-done item starting at or after it by `minutes`
 * (negative to pull earlier). Time-locked items (muhurat) stay put.
 */
export async function shiftItems(db: Database, eventId: string, fromItemId: string, minutes: number) {
  const mins = Math.trunc(minutes);
  if (!mins || Math.abs(mins) > 12 * 60) throw new RunSheetError("invalid");
  return db.transaction(async (tx) => {
    const from = await getItem(tx, eventId, fromItemId);
    const moved = await tx
      .update(runSheetItems)
      .set({ startsAt: sql`${runSheetItems.startsAt} + make_interval(mins => ${mins})`, updatedAt: new Date() })
      .where(
        and(
          eq(runSheetItems.functionId, from.functionId),
          eq(runSheetItems.timeLocked, false),
          sql`${runSheetItems.status} <> 'done'`,
          // Includes items in parallel with this one (same start), so they stay together.
          sql`${runSheetItems.startsAt} >= ${from.startsAt.toISOString().slice(0, 19)}::timestamp`,
        ),
      )
      .returning({ id: runSheetItems.id });
    return moved.length;
  });
}

export async function listItems(db: Tx, eventId: string, functionId: string) {
  return db
    .select({ item: runSheetItems, ownerUserName: users.name, ownerVendorName: vendors.name })
    .from(runSheetItems)
    .leftJoin(users, eq(users.id, runSheetItems.ownerUserId))
    .leftJoin(vendors, eq(vendors.id, runSheetItems.ownerVendorId))
    .where(and(eq(runSheetItems.eventId, eventId), eq(runSheetItems.functionId, functionId)))
    .orderBy(asc(runSheetItems.startsAt), asc(runSheetItems.sortOrder), asc(runSheetItems.createdAt));
}

export async function itemsAfter(db: Tx, functionId: string, at: Date) {
  return db
    .select()
    .from(runSheetItems)
    .where(and(eq(runSheetItems.functionId, functionId), gt(runSheetItems.startsAt, at)))
    .orderBy(asc(runSheetItems.startsAt));
}

const endOf = (i: Pick<RunSheetItem, "startsAt" | "durationMin">) => addMinutes(i.startsAt, i.durationMin ?? 15);

/**
 * The day-of view (ITN-03) at wall-clock time `now`:
 * - current: in progress, or scheduled now and not done
 * - next: the first pending item starting after now
 * - late: pending items whose start has passed (should have started)
 */
export function liveView<T extends Pick<RunSheetItem, "startsAt" | "durationMin" | "status">>(items: T[], now: Date) {
  const current = items.filter((i) => i.status === "in_progress" || (i.status === "pending" && i.startsAt <= now && endOf(i) > now));
  const late = items.filter((i) => i.status === "pending" && endOf(i) <= now);
  const next = items.find((i) => i.status === "pending" && i.startsAt > now) ?? null;
  return { current, next, late };
}

/** Pairs of items that overlap a time-locked item (after a shift, say). */
export function lockedOverlaps<T extends Pick<RunSheetItem, "id" | "startsAt" | "durationMin" | "timeLocked" | "title">>(items: T[]) {
  const out: { locked: T; other: T }[] = [];
  for (const l of items.filter((i) => i.timeLocked)) {
    for (const o of items) {
      if (o.id === l.id) continue;
      if (o.startsAt < endOf(l) && endOf(o) > l.startsAt) out.push({ locked: l, other: o });
    }
  }
  return out;
}

export { runItemStatus };
