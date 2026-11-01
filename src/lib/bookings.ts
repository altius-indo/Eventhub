import { and, asc, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  approvalRequests,
  bookingKeyDates,
  bookings,
  eventMembers,
  events,
  fulfilments,
  functions,
  paymentMilestones,
  quoteLines,
  quotes,
  requirements,
  serviceTypes,
  services,
  tasks,
  vendors,
  type Booking,
  type Quote,
  type QuoteLine,
} from "@/db/schema";
import { ApprovalError, refreshOpenRequest, stagedResult, registerApprovalHandler, submitChangeTx, type SubmitResult } from "./approvals";
import { audit, type Actor } from "./audit";
import { canAutoApprove, overspendFor } from "./budget";
import { allocate } from "./money";
import { decide, ForbiddenError, type PolicySubject } from "./policy";
import { allocatePackages, lineGst, splitGst } from "./quotes";
import { payerSchema } from "./services";
import { todayIn } from "./tasks";

export class BookingError extends Error {
  constructor(
    public code:
      | "not_found"
      | "no_lines"
      | "already_booked"
      | "not_approved"
      | "all_or_nothing"
      | "declined"
      | "schedule_mismatch"
      | "not_confirmed"
      | "not_latest"
      | "invalid",
  ) {
    super(code);
  }
}

type Ctx = { eventId: string; actor: Actor; subject: PolicySubject };

export const milestoneSchema = z.object({
  kind: z.enum(["advance", "milestone", "final"]),
  label: z.string().trim().max(120).nullable(),
  amountPaise: z.number().int().min(0).max(1e13),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  payer: payerSchema.nullable(),
});
export type MilestoneInput = z.infer<typeof milestoneSchema>;

export type BookingWarning =
  | { code: "condition_dropped"; lines: number }
  | { code: "over_covered"; requirement: string }
  | { code: "expired"; validUntil: string };

type Computed = {
  quote: Quote;
  rows: { serviceId: string; requirementId: string | null; quoteLineId: string; quantity: number | null; amountPaise: number; gstPaise: number }[];
  subtotal: number;
  gst: number;
  functionIds: string[];
  lastDate: string | null;
  warnings: BookingWarning[];
};

/**
 * Works out the fulfilments for accepting `lineIds` of a quote (VND-06), applying the package
 * conditions (VND-04): all-or-nothing quotes must be taken whole, and conditional lines
 * (e.g. a bundle discount) drop out when the minimum number of functions isn't booked.
 */
async function computeBooking(tx: Tx, eventId: string, quoteId: string, lineIds: string[], today: string | null, excludeBookingId?: string): Promise<Computed> {
  const [quote] = await tx.select().from(quotes).where(and(eq(quotes.id, quoteId), eq(quotes.eventId, eventId)));
  if (!quote) throw new BookingError("not_found");
  if (quote.declinedAt) throw new BookingError("declined");
  const lines = await tx.select().from(quoteLines).where(eq(quoteLines.quoteId, quote.id)).orderBy(asc(quoteLines.sortOrder));
  const wanted = new Set(lineIds);
  if ([...wanted].some((id) => !lines.some((l) => l.id === id))) throw new BookingError("invalid");
  const chosen = lines.filter((l) => wanted.has(l.id));
  const own = chosen.filter((l) => l.scope !== "package");
  if (own.length === 0) throw new BookingError("no_lines");

  const allOwn = lines.filter((l) => l.scope !== "package");
  if (quote.allOrNothing && allOwn.some((l) => !wanted.has(l.id))) throw new BookingError("all_or_nothing");

  // Services and requirements must be approved and live; lock requirements in id order.
  const serviceIds = [...new Set(own.map((l) => l.serviceId!))];
  const svc = await tx
    .select({ id: services.id, functionId: services.functionId, approvalState: services.approvalState, cancelledAt: services.cancelledAt, date: functions.date })
    .from(services)
    .innerJoin(functions, eq(functions.id, services.functionId))
    .where(and(eq(services.eventId, eventId), inArray(services.id, serviceIds)));
  if (svc.length !== serviceIds.length) throw new BookingError("not_found");
  if (svc.some((s) => s.approvalState !== "approved" || s.cancelledAt)) throw new BookingError("not_approved");
  const reqIds = [...new Set(own.map((l) => l.requirementId).filter((x): x is string => !!x))].sort();
  const reqs = reqIds.length
    ? await tx.select().from(requirements).where(inArray(requirements.id, reqIds)).orderBy(asc(requirements.id)).for("update")
    : [];
  if (reqs.some((r) => r.approvalState !== "approved" || r.lifecycle === "cancelled")) throw new BookingError("not_approved");

  const warnings: BookingWarning[] = [];
  const allServiceIds = new Set(allOwn.map((l) => l.serviceId!));
  const allFunctions = new Set(svc.map((s) => s.functionId));
  const conditionMet = quote.minFunctions != null ? allFunctions.size >= quote.minFunctions : serviceIds.length === allServiceIds.size;
  const packages = chosen.filter((l) => l.scope === "package" && (!l.conditional || conditionMet));
  const dropped = chosen.filter((l) => l.scope === "package" && l.conditional && !conditionMet).length;
  if (dropped) warnings.push({ code: "condition_dropped", lines: dropped });
  if (quote.validUntil && today && quote.validUntil < today) warnings.push({ code: "expired", validUntil: quote.validUntil });

  const rows: Computed["rows"] = own.map((l) => ({
    serviceId: l.serviceId!,
    requirementId: l.requirementId,
    quoteLineId: l.id,
    quantity: l.scope === "requirement" ? l.quantity : null,
    amountPaise: l.amountPaise,
    gstPaise: lineGst(l, quote.taxType),
  }));
  const alloc = allocatePackages([...own, ...packages] as QuoteLine[], serviceIds);
  for (const p of packages) {
    const parts = alloc.get(p.id)!;
    const ids = [...parts.keys()];
    const gst = splitGst(lineGst(p, quote.taxType), ids.map((id) => parts.get(id)!));
    ids.forEach((id, i) => {
      if (parts.get(id) !== 0 || gst[i] !== 0) rows.push({ serviceId: id, requirementId: null, quoteLineId: p.id, quantity: null, amountPaise: parts.get(id)!, gstPaise: gst[i] });
    });
  }

  // Over-coverage is a warning (e.g. a deliberate backup caterer), not a block.
  if (reqs.length) {
    const existing = await tx
      .select({ requirementId: fulfilments.requirementId, quantity: fulfilments.quantity })
      .from(fulfilments)
      .innerJoin(bookings, eq(bookings.id, fulfilments.bookingId))
      .where(and(inArray(fulfilments.requirementId, reqIds), isNull(fulfilments.cancelledAt), ne(bookings.status, "cancelled"), excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined));
    for (const r of reqs) {
      if (r.quantity == null) continue;
      const before = existing.filter((e) => e.requirementId === r.id);
      const mine = rows.filter((x) => x.requirementId === r.id);
      const full = [...before, ...mine].some((x) => x.quantity == null);
      const qty = [...before, ...mine].reduce((a, x) => a + (x.quantity ?? 0), 0);
      if ((before.length && full) || qty > r.quantity) warnings.push({ code: "over_covered", requirement: r.title });
    }
  }
  const subtotal = rows.reduce((a, r) => a + r.amountPaise, 0);
  const gst = rows.reduce((a, r) => a + r.gstPaise, 0);
  const dates = svc.map((s) => s.date).filter((d): d is string => !!d).sort();
  return { quote, rows, subtotal, gst, functionIds: [...allFunctions], lastDate: dates[dates.length - 1] ?? null, warnings };
}

/** Default schedule: 50% advance now, the rest on the last function day (PAY-02). */
export function defaultSchedule(total: number, today: string, lastDate: string | null): MilestoneInput[] {
  if (total <= 0) return [];
  const [advance, rest] = allocate(total, [1, 1]);
  return [
    { kind: "advance", label: null, amountPaise: advance, dueDate: today, payer: null },
    { kind: "final", label: null, amountPaise: rest, dueDate: lastDate && lastDate > today ? lastDate : today, payer: null },
  ];
}

function checkSchedule(milestones: MilestoneInput[], total: number) {
  const sum = milestones.reduce((a, m) => a + m.amountPaise, 0);
  if (milestones.length && sum !== total) throw new BookingError("schedule_mismatch");
}

async function categoryAdditions(tx: Tx, rows: { serviceId: string; amountPaise: number; gstPaise: number }[]) {
  const ids = [...new Set(rows.map((r) => r.serviceId))];
  const cats = ids.length ? await tx.select({ id: services.id, categoryId: services.serviceTypeId }).from(services).where(inArray(services.id, ids)) : [];
  const out = new Map<string, number>();
  for (const r of rows) {
    const c = cats.find((x) => x.id === r.serviceId)!.categoryId;
    out.set(c, (out.get(c) ?? 0) + r.amountPaise + r.gstPaise);
  }
  return out;
}

/**
 * Proposes a booking from a quote selection. It is "pending approval" (fulfilments tentative,
 * schedule inactive) until a Host approves, unless a Host books it or it's under the
 * category thresholds without overspend (BGT-04).
 */
export async function proposeBooking(
  db: Database,
  ctx: Ctx,
  input: { quoteId: string; lineIds: string[]; milestones?: MilestoneInput[] | null; notes?: string | null; today: string },
): Promise<{ booking: Booking; result: SubmitResult; warnings: BookingWarning[] }> {
  if (decide(ctx.subject, "bookings.create") === "deny") throw new ForbiddenError("bookings.create");
  return db.transaction(async (tx) => {
    // One live booking per quote (any version): serialise on the quote's root row.
    const [q0] = await tx.select({ rootId: quotes.rootId }).from(quotes).where(and(eq(quotes.id, input.quoteId), eq(quotes.eventId, ctx.eventId)));
    if (!q0) throw new BookingError("not_found");
    await tx.select({ id: quotes.id }).from(quotes).where(eq(quotes.id, q0.rootId)).for("update");
    const c = await computeBooking(tx, ctx.eventId, input.quoteId, input.lineIds, input.today);
    const live = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .innerJoin(quotes, eq(quotes.id, bookings.quoteId))
      .where(and(eq(quotes.rootId, c.quote.rootId), ne(bookings.status, "cancelled")));
    if (live.length) throw new BookingError("already_booked");
    const total = c.subtotal + c.gst;
    const milestones = input.milestones ?? defaultSchedule(total, input.today, c.lastDate);
    checkSchedule(milestones, total);
    const [booking] = await tx
      .insert(bookings)
      .values({
        eventId: ctx.eventId,
        vendorId: c.quote.vendorId,
        quoteId: c.quote.id,
        subtotalPaise: c.subtotal,
        gstPaise: c.gst,
        notes: input.notes?.trim() || null,
        createdBy: ctx.actor.userId,
      })
      .returning();
    await tx.insert(fulfilments).values(c.rows.map((r) => ({ eventId: ctx.eventId, bookingId: booking.id, ...r })));
    if (milestones.length) await tx.insert(paymentMilestones).values(milestones.map((m, i) => ({ eventId: ctx.eventId, bookingId: booking.id, ...m, sortOrder: i + 1 })));
    const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, c.quote.vendorId));
    const result = await submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "booking.create",
      title: v?.name ?? "",
      payload: { bookingId: booking.id, version: booking.version },
      amountPaise: total,
      entityType: "booking",
      entityId: booking.id,
      functionIds: c.functionIds,
    });
    const [fresh] = await tx.select().from(bookings).where(eq(bookings.id, booking.id));
    return { booking: fresh, result, warnings: c.warnings };
  });
}

async function lockBooking(tx: Tx, eventId: string, bookingId: string) {
  const [b] = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.eventId, eventId)))
    .for("update");
  if (!b) throw new BookingError("not_found");
  return b;
}

async function cancelBookingRows(tx: Tx, b: Booking, reason: string) {
  await tx.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason || null }).where(eq(bookings.id, b.id));
  await tx.update(fulfilments).set({ cancelledAt: new Date() }).where(and(eq(fulfilments.bookingId, b.id), isNull(fulfilments.cancelledAt)));
}

const bookingIdPayload = z.object({ bookingId: z.string().uuid() }).passthrough();

registerApprovalHandler("booking.create", {
  permission: "bookings.create",
  async apply(tx, payload, { eventId, actor }) {
    const { bookingId, version } = bookingIdPayload.extend({ version: z.number().int().optional() }).parse(payload);
    const b = await lockBooking(tx, eventId, bookingId);
    if (b.status === "confirmed") return;
    if (b.status !== "pending_approval") throw new ApprovalError("stale");
    if (version !== undefined && version !== b.version) throw new ApprovalError("stale");
    // Everything it books must still be live.
    const rows = await tx
      .select({ sState: services.approvalState, sCancelled: services.cancelledAt, rState: requirements.approvalState, rLife: requirements.lifecycle })
      .from(fulfilments)
      .innerJoin(services, eq(services.id, fulfilments.serviceId))
      .leftJoin(requirements, eq(requirements.id, fulfilments.requirementId))
      .where(and(eq(fulfilments.bookingId, b.id), isNull(fulfilments.cancelledAt)));
    if (rows.some((r) => r.sState !== "approved" || r.sCancelled || (r.rState && (r.rState !== "approved" || r.rLife === "cancelled")))) {
      throw new ApprovalError("stale");
    }
    await tx.update(bookings).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(bookings.id, b.id));
    // An advance due before the Host confirmed is due on the day of confirmation, not overdue.
    const [ev] = await tx.select({ tz: events.timezone }).from(events).where(eq(events.id, eventId));
    const today = todayIn(ev?.tz ?? "Asia/Kolkata");
    await tx
      .update(paymentMilestones)
      .set({ dueDate: today })
      .where(and(eq(paymentMilestones.bookingId, b.id), eq(paymentMilestones.kind, "advance"), lt(paymentMilestones.dueDate, today)));
    await audit(tx, { eventId, actor, action: "booking.confirmed", entityType: "booking", entityId: b.id, data: { amount: b.subtotalPaise + b.gstPaise } });
  },
  async onClosed(tx, payload, { eventId }, outcome) {
    const { bookingId } = bookingIdPayload.parse(payload);
    const b = await lockBooking(tx, eventId, bookingId).catch(() => null);
    if (b?.status === "pending_approval") await cancelBookingRows(tx, b, outcome);
  },
  async autoApprove(tx, payload, eventId) {
    const { bookingId } = bookingIdPayload.parse(payload);
    const rows = await tx.select().from(fulfilments).where(and(eq(fulfilments.bookingId, bookingId), eq(fulfilments.eventId, eventId)));
    return canAutoApprove(tx, eventId, await categoryAdditions(tx, rows), { checkOverspend: true });
  },
});

/**
 * Cancels a booking. A pending booking is withdrawn at once; a confirmed one needs a Host
 * when a Planner asks. Payments already recorded stay (tracking only).
 */
export async function cancelBooking(db: Database, ctx: Ctx, bookingId: string, reason: string): Promise<SubmitResult> {
  if (decide(ctx.subject, "bookings.create") === "deny") throw new ForbiddenError("bookings.create");
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, ctx.eventId, bookingId);
    if (b.status === "cancelled") throw new BookingError("not_found");
    if (b.status === "pending_approval") {
      await cancelBookingRows(tx, b, reason);
      await tx
        .update(approvalRequests)
        .set({ status: "cancelled", decidedAt: new Date() })
        .where(and(eq(approvalRequests.entityId, b.id), inArray(approvalRequests.status, ["pending", "changes_requested"])));
      await audit(tx, { eventId: ctx.eventId, actor: ctx.actor, action: "booking.withdrawn", entityType: "booking", entityId: b.id });
      return { status: "applied" } as const;
    }
    const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, b.vendorId));
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "booking.cancel",
      title: v?.name ?? "",
      payload: { bookingId: b.id, reason: reason.slice(0, 500) },
      amountPaise: -(b.subtotalPaise + b.gstPaise),
      entityType: "booking",
      entityId: b.id,
    });
  });
}

registerApprovalHandler("booking.cancel", {
  permission: "bookings.create",
  async apply(tx, payload, { eventId, actor }) {
    const { bookingId, reason } = z.object({ bookingId: z.string().uuid(), reason: z.string().default("") }).parse(payload);
    const b = await lockBooking(tx, eventId, bookingId);
    if (b.status === "cancelled") return;
    await cancelBookingRows(tx, b, reason);
    await audit(tx, { eventId, actor, action: "booking.cancelled", entityType: "booking", entityId: b.id, data: { reason } });
  },
});

/**
 * Moves a confirmed booking to another version of its quote and/or a different selection
 * (VND-07). Changes to a commitment follow BGT-04: thresholds apply to the increase.
 */
export async function reviseBooking(db: Database, ctx: Ctx, bookingId: string, input: { quoteId: string; lineIds: string[]; today: string }) {
  if (decide(ctx.subject, "bookings.create") === "deny") throw new ForbiddenError("bookings.create");
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, ctx.eventId, bookingId);
    if (b.status !== "confirmed") throw new BookingError("not_confirmed");
    const [oldQ] = b.quoteId ? await tx.select().from(quotes).where(eq(quotes.id, b.quoteId)) : [];
    const c = await computeBooking(tx, ctx.eventId, input.quoteId, input.lineIds, input.today, b.id);
    if (!oldQ || c.quote.rootId !== oldQ.rootId) throw new BookingError("invalid");
    const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, b.vendorId));
    const result = await submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "booking.change",
      title: v?.name ?? "",
      payload: { bookingId: b.id, baseVersion: b.version, quoteId: c.quote.id, lineIds: input.lineIds, today: input.today },
      amountPaise: c.subtotal + c.gst - (b.subtotalPaise + b.gstPaise),
      entityType: "booking",
      entityId: b.id,
      functionIds: c.functionIds,
    });
    return { result, warnings: c.warnings };
  });
}

const changePayload = z.object({
  bookingId: z.string().uuid(),
  baseVersion: z.number().int(),
  quoteId: z.string().uuid(),
  lineIds: z.array(z.string().uuid()),
  today: z.string(),
});

registerApprovalHandler("booking.change", {
  permission: "bookings.create",
  async apply(tx, payload, { eventId, actor }) {
    const p = changePayload.parse(payload);
    const b = await lockBooking(tx, eventId, p.bookingId);
    if (b.version !== p.baseVersion || b.status !== "confirmed") throw new ApprovalError("stale");
    const c = await computeBooking(tx, eventId, p.quoteId, p.lineIds, null, b.id).catch(() => {
      throw new ApprovalError("stale");
    });
    await tx.update(fulfilments).set({ cancelledAt: new Date() }).where(and(eq(fulfilments.bookingId, b.id), isNull(fulfilments.cancelledAt)));
    await tx.insert(fulfilments).values(c.rows.map((r) => ({ eventId, bookingId: b.id, ...r })));
    const total = c.subtotal + c.gst;
    // Rescale the schedule to the new total, keeping its shape.
    const ms = await tx.select().from(paymentMilestones).where(eq(paymentMilestones.bookingId, b.id)).orderBy(asc(paymentMilestones.sortOrder));
    if (ms.length) {
      const parts = allocate(total, ms.map((m) => m.amountPaise));
      for (let i = 0; i < ms.length; i++) await tx.update(paymentMilestones).set({ amountPaise: parts[i] }).where(eq(paymentMilestones.id, ms[i].id));
    }
    await tx
      .update(bookings)
      .set({ quoteId: c.quote.id, subtotalPaise: c.subtotal, gstPaise: c.gst, version: b.version + 1 })
      .where(eq(bookings.id, b.id));
    await audit(tx, {
      eventId,
      actor,
      action: "booking.changed",
      entityType: "booking",
      entityId: b.id,
      data: { from: b.subtotalPaise + b.gstPaise, to: total },
    });
  },
  async autoApprove(tx, payload, eventId) {
    const p = changePayload.parse(payload);
    const b = await lockBooking(tx, eventId, p.bookingId);
    const c = await computeBooking(tx, eventId, p.quoteId, p.lineIds, null, b.id);
    const before = await tx.select().from(fulfilments).where(and(eq(fulfilments.bookingId, b.id), isNull(fulfilments.cancelledAt)));
    const after = await categoryAdditions(tx, c.rows);
    const prev = await categoryAdditions(tx, before);
    const delta = new Map<string, number>();
    for (const k of new Set([...after.keys(), ...prev.keys()])) delta.set(k, (after.get(k) ?? 0) - (prev.get(k) ?? 0));
    return canAutoApprove(tx, eventId, delta, { checkOverspend: true });
  },
});

/**
 * Edits the payment schedule (PAY-02). The total must equal the booking amount. While the
 * booking awaits approval its schedule is part of that proposal; afterwards a Planner's
 * change needs a Host.
 */
export async function updateSchedule(db: Database, ctx: Ctx, bookingId: string, milestones: MilestoneInput[]): Promise<SubmitResult> {
  const decision = decide(ctx.subject, "bookings.create");
  if (decision === "deny") throw new ForbiddenError("bookings.create");
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, ctx.eventId, bookingId);
    if (b.status === "cancelled") throw new BookingError("not_found");
    checkSchedule(milestones, b.subtotalPaise + b.gstPaise);
    if (b.status === "pending_approval") {
      await replaceMilestones(tx, ctx.eventId, b.id, milestones);
      // The schedule is part of the pending booking: re-send it so the Host sees the new version.
      await tx.update(bookings).set({ version: b.version + 1 }).where(eq(bookings.id, b.id));
      return stagedResult(await refreshOpenRequest(tx, { eventId: ctx.eventId, entityType: "booking", entityId: b.id, actor: ctx.actor, payload: { bookingId: b.id, version: b.version + 1 } }));
    }
    const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, b.vendorId));
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "booking.schedule",
      title: v?.name ?? "",
      payload: { bookingId: b.id, baseVersion: b.version, milestones },
      entityType: "booking",
      entityId: b.id,
    });
  });
}

async function replaceMilestones(tx: Tx, eventId: string, bookingId: string, milestones: MilestoneInput[]) {
  await tx.delete(paymentMilestones).where(eq(paymentMilestones.bookingId, bookingId));
  if (milestones.length) await tx.insert(paymentMilestones).values(milestones.map((m, i) => ({ eventId, bookingId, ...m, sortOrder: i + 1 })));
}

registerApprovalHandler("booking.schedule", {
  permission: "bookings.create",
  async apply(tx, payload, { eventId, actor }) {
    const p = z.object({ bookingId: z.string().uuid(), baseVersion: z.number().int(), milestones: z.array(milestoneSchema) }).parse(payload);
    const b = await lockBooking(tx, eventId, p.bookingId);
    if (b.version !== p.baseVersion || b.status === "cancelled") throw new ApprovalError("stale");
    checkSchedule(p.milestones, b.subtotalPaise + b.gstPaise);
    await replaceMilestones(tx, eventId, b.id, p.milestones);
    await tx.update(bookings).set({ version: b.version + 1 }).where(eq(bookings.id, b.id));
    await audit(tx, { eventId, actor, action: "booking.schedule_changed", entityType: "booking", entityId: b.id });
  },
});

// ---------------------------------------------------------------------------
// Contract terms and key dates (VND-09)
// ---------------------------------------------------------------------------

export async function updateContract(
  db: Database,
  eventId: string,
  actor: Actor,
  bookingId: string,
  input: { cancellationPolicy: string | null; deliverables: string | null; notes: string | null },
) {
  await db.transaction(async (tx) => {
    const [b] = await tx
      .update(bookings)
      .set({ cancellationPolicy: input.cancellationPolicy?.trim() || null, deliverables: input.deliverables?.trim() || null, notes: input.notes?.trim() || null })
      .where(and(eq(bookings.id, bookingId), eq(bookings.eventId, eventId)))
      .returning({ id: bookings.id });
    if (!b) throw new BookingError("not_found");
    await audit(tx, { eventId, actor, action: "booking.contract_changed", entityType: "booking", entityId: b.id });
  });
}

/** A key date becomes a task, so the daily task reminders cover it. */
export async function addKeyDate(db: Database, eventId: string, actor: Actor, bookingId: string, input: { label: string; date: string; assigneeId: string | null }) {
  return db.transaction(async (tx) => {
    const b = await lockBooking(tx, eventId, bookingId);
    if (input.assigneeId) {
      const [m] = await tx.select({ id: eventMembers.id }).from(eventMembers).where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, input.assigneeId)));
      if (!m) throw new BookingError("invalid");
    }
    const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, b.vendorId));
    const [task] = await tx
      .insert(tasks)
      .values({ eventId, title: `${v?.name ?? ""}: ${input.label}`.slice(0, 200), dueDate: input.date, assigneeId: input.assigneeId, createdBy: actor.userId, priority: "high" })
      .returning();
    const [row] = await tx.insert(bookingKeyDates).values({ eventId, bookingId: b.id, label: input.label, date: input.date, taskId: task.id }).returning();
    await audit(tx, { eventId, actor, action: "booking.key_date_added", entityType: "booking", entityId: b.id, data: { label: input.label, date: input.date } });
    return row;
  });
}

export async function removeKeyDate(db: Database, eventId: string, keyDateId: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .delete(bookingKeyDates)
      .where(and(eq(bookingKeyDates.id, keyDateId), eq(bookingKeyDates.eventId, eventId)))
      .returning();
    if (!row) throw new BookingError("not_found");
    if (row.taskId) await tx.delete(tasks).where(and(eq(tasks.id, row.taskId), eq(tasks.eventId, eventId)));
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getBooking(db: Tx, eventId: string, bookingId: string) {
  const [row] = await db
    .select({ booking: bookings, vendor: vendors, quote: quotes })
    .from(bookings)
    .innerJoin(vendors, eq(vendors.id, bookings.vendorId))
    .leftJoin(quotes, eq(quotes.id, bookings.quoteId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.eventId, eventId)));
  if (!row) throw new BookingError("not_found");
  const fs = await db
    .select({
      f: fulfilments,
      requirementTitle: requirements.title,
      requirementQty: requirements.quantity,
      unit: requirements.unit,
      serviceName: services.name,
      typeName: serviceTypes.name,
      typeKey: serviceTypes.systemKey,
      functionName: functions.name,
      functionDate: functions.date,
      lineDescription: quoteLines.description,
      lineScope: quoteLines.scope,
    })
    .from(fulfilments)
    .innerJoin(services, eq(services.id, fulfilments.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .leftJoin(requirements, eq(requirements.id, fulfilments.requirementId))
    .leftJoin(quoteLines, eq(quoteLines.id, fulfilments.quoteLineId))
    .where(and(eq(fulfilments.bookingId, row.booking.id), isNull(fulfilments.cancelledAt)))
    .orderBy(asc(functions.date), asc(services.sortOrder), asc(requirements.sortOrder));
  const milestones = await db.select().from(paymentMilestones).where(eq(paymentMilestones.bookingId, row.booking.id)).orderBy(asc(paymentMilestones.sortOrder));
  const keyDates = await db.select().from(bookingKeyDates).where(eq(bookingKeyDates.bookingId, row.booking.id)).orderBy(asc(bookingKeyDates.date));
  return { ...row, fulfilments: fs, milestones, keyDates, total: row.booking.subtotalPaise + row.booking.gstPaise };
}

export async function listBookings(db: Tx, eventId: string, opts: { vendorId?: string; includeCancelled?: boolean } = {}) {
  return db
    .select({ booking: bookings, vendorName: vendors.name })
    .from(bookings)
    .innerJoin(vendors, eq(vendors.id, bookings.vendorId))
    .where(
      and(
        eq(bookings.eventId, eventId),
        opts.vendorId ? eq(bookings.vendorId, opts.vendorId) : undefined,
        opts.includeCancelled ? undefined : ne(bookings.status, "cancelled"),
      ),
    )
    .orderBy(desc(bookings.createdAt));
}

/** The live booking (if any) of a quote's root, so the quote page can show "booked". */
export async function bookingForQuoteRoot(db: Tx, eventId: string, rootId: string) {
  const [b] = await db
    .select({ booking: bookings })
    .from(bookings)
    .innerJoin(quotes, eq(quotes.id, bookings.quoteId))
    .where(and(eq(bookings.eventId, eventId), eq(quotes.rootId, rootId), ne(bookings.status, "cancelled")));
  return b?.booking ?? null;
}

/** Categories a pending booking would push over plan (shown to the Host deciding, BGT-04). */
export async function bookingOverspend(db: Tx, eventId: string, bookingId: string) {
  const rows = await db.select().from(fulfilments).where(and(eq(fulfilments.bookingId, bookingId), eq(fulfilments.eventId, eventId), isNull(fulfilments.cancelledAt)));
  return overspendFor(db, eventId, await categoryAdditions(db, rows));
}

/**
 * Maps what a booking took from one quote version onto another (VND-07): the same requirement,
 * the same service extra, or the package line in the same position. Lines for requirements
 * that are no longer live are left out.
 */
export function matchLines(oldLines: QuoteLine[], newLines: QuoteLine[], selectedOldIds: string[], liveRequirementIds: Set<string>): string[] {
  const chosen = oldLines.filter((l) => selectedOldIds.includes(l.id));
  const oldPkg = oldLines.filter((l) => l.scope === "package");
  const newPkg = newLines.filter((l) => l.scope === "package");
  const out = new Set<string>();
  for (const l of chosen) {
    let m: QuoteLine | undefined;
    if (l.scope === "requirement") m = newLines.find((n) => n.scope === "requirement" && n.requirementId === l.requirementId);
    else if (l.scope === "service") m = newLines.find((n) => n.scope === "service" && n.serviceId === l.serviceId);
    else m = newPkg[oldPkg.indexOf(l)];
    if (m && (!m.requirementId || liveRequirementIds.has(m.requirementId))) out.add(m.id);
  }
  return [...out];
}
