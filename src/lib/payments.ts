import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  approvalRequests,
  bookings,
  budgetLines,
  eventMembers,
  events,
  invoiceLines,
  invoices,
  paymentMilestones,
  payments,
  services,
  userIdentifiers,
  users,
  vendors,
  type Payment,
  type PaymentMilestone,
} from "@/db/schema";
import { createTranslator, formatInr, isLocale } from "@/i18n/core";
import { ApprovalError, registerApprovalHandler, submitChangeTx, type SubmitResult } from "./approvals";
import { audit, type Actor } from "./audit";
import { linkBase } from "./app-url";
import { DeliveryError, sendMessage } from "./delivery";
import { gstFor, isValidGstin } from "./money";
import { decide, ForbiddenError, type PolicySubject } from "./policy";
import { payerSchema } from "./services";
import { todayIn } from "./tasks";

export class PaymentError extends Error {
  constructor(
    public code: "not_found" | "invalid" | "overpayment" | "booking_pending" | "duplicate_number" | "invalid_gstin" | "has_payments",
  ) {
    super(code);
  }
}

type Ctx = { eventId: string; actor: Actor; subject: PolicySubject };

// ---------------------------------------------------------------------------
// Status rules (PAY-04, ADR-0020): derived at read time from the event-local date.
// ---------------------------------------------------------------------------

export type PayStatus = "paid" | "overdue" | "partially_paid" | "due" | "upcoming";
export const DUE_WINDOW_DAYS = 7;

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86_400_000;

export function payStatus(amount: number, paid: number, dueDate: string | null, today: string): PayStatus {
  if (paid >= amount) return "paid";
  if (dueDate && dayNum(today) > dayNum(dueDate)) return "overdue";
  if (paid > 0) return "partially_paid";
  if (dueDate && dayNum(dueDate) - dayNum(today) <= DUE_WINDOW_DAYS) return "due";
  return "upcoming";
}

/** Confirmed payments fill milestones in schedule order (FIFO). */
export function milestoneStatuses(milestones: PaymentMilestone[], paidTotal: number, today: string) {
  let left = paidTotal;
  return milestones.map((m) => {
    const paid = Math.min(Math.max(left, 0), m.amountPaise);
    left -= paid;
    return { milestone: m, paid, remaining: m.amountPaise - paid, status: payStatus(m.amountPaise, paid, m.dueDate, today) };
  });
}

// ---------------------------------------------------------------------------
// Invoices (PAY-01, VND-08)
// ---------------------------------------------------------------------------

export const invoiceLineInput = z.object({
  serviceId: z.string().uuid().nullable(),
  description: z.string().trim().min(1).max(300),
  hsnSac: z.string().trim().max(10).nullable(),
  amountPaise: z.number().int().min(-1e12).max(1e12),
  gstRateBps: z.number().int().min(0).max(10_000),
});

export const invoiceInput = z.object({
  vendorId: z.string().uuid(),
  bookingId: z.string().uuid().nullable(),
  number: z.string().trim().min(1).max(60),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  supplierGstin: z.string().trim().toUpperCase().max(15).nullable(),
  taxType: z.enum(["none", "cgst_sgst", "igst"]),
  /** Total as printed on the invoice; when it differs from the lines by more than ₹1 it's flagged. */
  printedTotalPaise: z.number().int().nullable(),
  notes: z.string().trim().max(2000).nullable(),
  lines: z.array(invoiceLineInput).min(1).max(200),
});
export type InvoiceInput = z.infer<typeof invoiceInput>;

export function invoiceTotals(lines: { amountPaise: number; gstRateBps: number }[], taxType: InvoiceInput["taxType"]) {
  let subtotal = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const l of lines) {
    const g = gstFor(l.amountPaise, l.gstRateBps, taxType);
    subtotal += l.amountPaise;
    cgst += g.cgst;
    sgst += g.sgst;
    igst += g.igst;
  }
  return { subtotal, cgst, sgst, igst, total: subtotal + cgst + sgst + igst };
}

export async function createInvoice(
  db: Database,
  eventId: string,
  actor: Actor,
  input: InvoiceInput,
  /** Vendor portal uploads (VND-10): source "vendor", plus a hook run in the same transaction. */
  opts: { source?: "team" | "vendor"; after?: (tx: Tx, invoice: typeof invoices.$inferSelect) => Promise<void> } = {},
) {
  if (input.supplierGstin && !isValidGstin(input.supplierGstin)) throw new PaymentError("invalid_gstin");
  try {
    return await db.transaction(async (tx) => {
      const [v] = await tx.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, input.vendorId), eq(vendors.eventId, eventId)));
      if (!v) throw new PaymentError("invalid");
      if (input.bookingId) {
        const [b] = await tx.select().from(bookings).where(and(eq(bookings.id, input.bookingId), eq(bookings.eventId, eventId)));
        if (!b || b.vendorId !== input.vendorId) throw new PaymentError("invalid");
      }
      const svcIds = [...new Set(input.lines.map((l) => l.serviceId).filter((x): x is string => !!x))];
      if (svcIds.length) {
        const ok = await tx.select({ id: services.id }).from(services).where(and(eq(services.eventId, eventId), inArray(services.id, svcIds)));
        if (ok.length !== svcIds.length) throw new PaymentError("invalid");
      }
      const t = invoiceTotals(input.lines, input.taxType);
      const [inv] = await tx
        .insert(invoices)
        .values({
          eventId,
          vendorId: input.vendorId,
          bookingId: input.bookingId,
          number: input.number,
          invoiceDate: input.invoiceDate,
          dueDate: input.dueDate,
          supplierGstin: input.supplierGstin || null,
          taxType: input.taxType,
          subtotalPaise: t.subtotal,
          cgstPaise: t.cgst,
          sgstPaise: t.sgst,
          igstPaise: t.igst,
          totalPaise: input.printedTotalPaise ?? t.total,
          notes: input.notes,
          source: opts.source ?? "team",
          createdBy: actor.userId,
        })
        .returning();
      await tx.insert(invoiceLines).values(input.lines.map((l, i) => ({ eventId, invoiceId: inv.id, ...l, sortOrder: i + 1 })));
      await audit(tx, {
        eventId,
        actor,
        action: opts.source === "vendor" ? "invoice.vendor_uploaded" : "invoice.added",
        entityType: "invoice",
        entityId: inv.id,
        data: { number: inv.number, amount: inv.totalPaise },
      });
      if (opts.after) await opts.after(tx, inv);
      return inv;
    });
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if (err?.code === "23505" || err?.cause?.code === "23505") throw new PaymentError("duplicate_number");
    throw e;
  }
}

export async function deleteInvoice(db: Database, eventId: string, actor: Actor, invoiceId: string) {
  await db.transaction(async (tx) => {
    // Invoices with payments recorded against them stay (the money trail, EVT-06).
    const [paid] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.invoiceId, invoiceId), eq(payments.eventId, eventId))).limit(1);
    if (paid) throw new PaymentError("has_payments");
    const [inv] = await tx.delete(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.eventId, eventId))).returning();
    if (!inv) throw new PaymentError("not_found");
    await audit(tx, { eventId, actor, action: "invoice.deleted", entityType: "invoice", entityId: inv.id, data: { number: inv.number, amount: inv.totalPaise } });
  });
}

/** Printed total vs computed from lines: a difference over ₹1 is shown as a warning. */
export const invoiceMismatch = (inv: { totalPaise: number; subtotalPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }) =>
  Math.abs(inv.totalPaise - (inv.subtotalPaise + inv.cgstPaise + inv.sgstPaise + inv.igstPaise)) > 100;

export async function getInvoice(db: Tx, eventId: string, invoiceId: string, today: string) {
  const [row] = await db
    .select({ invoice: invoices, vendorName: vendors.name })
    .from(invoices)
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(and(eq(invoices.id, invoiceId), eq(invoices.eventId, eventId)));
  if (!row) throw new PaymentError("not_found");
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, row.invoice.id)).orderBy(asc(invoiceLines.sortOrder));
  const pays = await db.select().from(payments).where(and(eq(payments.invoiceId, row.invoice.id), eq(payments.state, "confirmed")));
  const paid = pays.reduce((a, p) => a + p.amountPaise, 0);
  return { ...row, lines, paid, status: payStatus(row.invoice.totalPaise, paid, row.invoice.dueDate, today), mismatch: invoiceMismatch(row.invoice) };
}

export async function listInvoices(db: Tx, eventId: string, today: string, opts: { vendorId?: string; bookingId?: string } = {}) {
  const rows = await db
    .select({ invoice: invoices, vendorName: vendors.name })
    .from(invoices)
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(
      and(
        eq(invoices.eventId, eventId),
        opts.vendorId ? eq(invoices.vendorId, opts.vendorId) : undefined,
        opts.bookingId ? eq(invoices.bookingId, opts.bookingId) : undefined,
      ),
    )
    .orderBy(desc(invoices.invoiceDate));
  const ids = rows.map((r) => r.invoice.id);
  const paid = ids.length
    ? await db
        .select({ invoiceId: payments.invoiceId, total: sql<number>`sum(${payments.amountPaise})::bigint`.mapWith(Number) })
        .from(payments)
        .where(and(inArray(payments.invoiceId, ids), eq(payments.state, "confirmed")))
        .groupBy(payments.invoiceId)
    : [];
  return rows.map((r) => {
    const p = paid.find((x) => x.invoiceId === r.invoice.id)?.total ?? 0;
    return { ...r, paid: p, status: payStatus(r.invoice.totalPaise, p, r.invoice.dueDate, today), mismatch: invoiceMismatch(r.invoice) };
  });
}

// ---------------------------------------------------------------------------
// Payments (PAY-03): a Planner's payment is "recorded, awaiting Host confirmation" (BGT-04)
// ---------------------------------------------------------------------------

export const paymentInput = z
  .object({
    bookingId: z.string().uuid().nullable(),
    budgetLineId: z.string().uuid().nullable(),
    invoiceId: z.string().uuid().nullable(),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amountPaise: z.number().int().min(1).max(1e13),
    mode: z.enum(["upi", "bank", "cheque", "cash", "card"]),
    reference: z.string().trim().max(100).nullable(),
    payer: payerSchema.nullable(),
    notes: z.string().trim().max(1000).nullable(),
    allowOverpay: z.boolean().default(false),
  })
  .refine((p) => (p.bookingId === null) !== (p.budgetLineId === null));
export type PaymentInput = z.infer<typeof paymentInput>;

export async function recordPayment(db: Database, ctx: Ctx, input: PaymentInput): Promise<{ payment: Payment; result: SubmitResult }> {
  if (decide(ctx.subject, "payments.record") === "deny") throw new ForbiddenError("payments.record");
  return db.transaction(async (tx) => {
    let title = "";
    if (input.bookingId) {
      const [b] = await tx
        .select({ booking: bookings, vendorName: vendors.name })
        .from(bookings)
        .innerJoin(vendors, eq(vendors.id, bookings.vendorId))
        .where(and(eq(bookings.id, input.bookingId), eq(bookings.eventId, ctx.eventId)))
        .for("update", { of: bookings });
      if (!b) throw new PaymentError("not_found");
      // No payments against a schedule that isn't active yet (BGT-04 blocking).
      if (b.booking.status !== "confirmed") throw new PaymentError("booking_pending");
      const [{ sum }] = await tx
        .select({ sum: sql<number>`coalesce(sum(${payments.amountPaise}), 0)::bigint`.mapWith(Number) })
        .from(payments)
        .where(and(eq(payments.bookingId, b.booking.id), inArray(payments.state, ["recorded", "confirmed"])));
      const outstanding = b.booking.subtotalPaise + b.booking.gstPaise - sum;
      if (input.amountPaise > outstanding && !input.allowOverpay) throw new PaymentError("overpayment");
      title = b.vendorName;
    } else {
      const [l] = await tx.select().from(budgetLines).where(and(eq(budgetLines.id, input.budgetLineId!), eq(budgetLines.eventId, ctx.eventId)));
      if (!l || l.approvalState !== "approved") throw new PaymentError("not_found");
      title = l.title;
    }
    if (input.invoiceId) {
      // Only an invoice of this booking (or this vendor's unlinked invoice); none for other costs.
      if (!input.bookingId) throw new PaymentError("invalid");
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.id, input.invoiceId), eq(invoices.eventId, ctx.eventId)));
      const [bk] = await tx.select({ vendorId: bookings.vendorId }).from(bookings).where(eq(bookings.id, input.bookingId));
      if (!inv || inv.vendorId !== bk?.vendorId || (inv.bookingId && inv.bookingId !== input.bookingId)) throw new PaymentError("invalid");
    }
    const { allowOverpay, ...row } = input;
    const [payment] = await tx
      .insert(payments)
      .values({ eventId: ctx.eventId, ...row, recordedBy: ctx.actor.userId })
      .returning();
    const result = await submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "payment.record",
      title,
      payload: { paymentId: payment.id, overpay: allowOverpay },
      amountPaise: payment.amountPaise,
      entityType: "payment",
      entityId: payment.id,
    });
    const [fresh] = await tx.select().from(payments).where(eq(payments.id, payment.id));
    return { payment: fresh, result };
  });
}

const paymentIdPayload = z.object({ paymentId: z.string().uuid() }).passthrough();

async function lockPayment(tx: Tx, eventId: string, id: string) {
  const [p] = await tx.select().from(payments).where(and(eq(payments.id, id), eq(payments.eventId, eventId))).for("update");
  if (!p) throw new PaymentError("not_found");
  return p;
}

/** Payments never auto-approve: a Host confirms every payment a Planner records. */
registerApprovalHandler("payment.record", {
  permission: "payments.record",
  async apply(tx, payload, { eventId, actor }) {
    const { paymentId } = paymentIdPayload.parse(payload);
    const p = await lockPayment(tx, eventId, paymentId);
    if (p.state === "confirmed") return;
    if (p.state !== "recorded") throw new ApprovalError("stale");
    await tx.update(payments).set({ state: "confirmed", confirmedBy: actor.userId, confirmedAt: new Date() }).where(eq(payments.id, p.id));
    await audit(tx, { eventId, actor, action: "payment.confirmed", entityType: "payment", entityId: p.id, data: { amount: p.amountPaise, mode: p.mode } });
  },
  async onClosed(tx, payload, { eventId }) {
    const { paymentId } = paymentIdPayload.parse(payload);
    const p = await lockPayment(tx, eventId, paymentId).catch(() => null);
    if (p?.state === "recorded") await tx.update(payments).set({ state: "rejected" }).where(eq(payments.id, p.id));
  },
});

/** Hosts can remove a payment entered by mistake; audited. */
export async function deletePayment(db: Database, ctx: Ctx, paymentId: string) {
  if (decide(ctx.subject, "payments.record") !== "allow") throw new ForbiddenError("payments.record");
  await db.transaction(async (tx) => {
    const p = await lockPayment(tx, ctx.eventId, paymentId);
    await tx.delete(payments).where(eq(payments.id, p.id));
    await tx
      .update(approvalRequests)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(and(eq(approvalRequests.entityId, p.id), inArray(approvalRequests.status, ["pending", "changes_requested"])));
    await audit(tx, { eventId: ctx.eventId, actor: ctx.actor, action: "payment.deleted", entityType: "payment", entityId: p.id, data: { amount: p.amountPaise, paidOn: p.paidOn } });
  });
}

export async function listPayments(db: Tx, eventId: string, opts: { bookingId?: string; budgetLineId?: string } = {}) {
  return db
    .select({ payment: payments, recordedByName: users.name })
    .from(payments)
    .leftJoin(users, eq(users.id, payments.recordedBy))
    .where(
      and(
        eq(payments.eventId, eventId),
        opts.bookingId ? eq(payments.bookingId, opts.bookingId) : undefined,
        opts.budgetLineId ? eq(payments.budgetLineId, opts.budgetLineId) : undefined,
      ),
    )
    .orderBy(desc(payments.paidOn), desc(payments.createdAt));
}

/** A booking's money position: total, confirmed paid, awaiting confirmation, milestone statuses. */
export async function bookingFinance(db: Tx, eventId: string, bookingId: string, today: string) {
  const [b] = await db.select().from(bookings).where(and(eq(bookings.id, bookingId), eq(bookings.eventId, eventId)));
  if (!b) throw new PaymentError("not_found");
  const ms = await db.select().from(paymentMilestones).where(eq(paymentMilestones.bookingId, b.id)).orderBy(asc(paymentMilestones.sortOrder));
  const pays = await listPayments(db, eventId, { bookingId: b.id });
  const paid = pays.filter((p) => p.payment.state === "confirmed").reduce((a, p) => a + p.payment.amountPaise, 0);
  const awaiting = pays.filter((p) => p.payment.state === "recorded").reduce((a, p) => a + p.payment.amountPaise, 0);
  const total = b.subtotalPaise + b.gstPaise;
  return {
    total,
    paid,
    awaiting,
    balance: total - paid,
    overpaid: paid > total,
    payments: pays,
    milestones: b.status === "confirmed" ? milestoneStatuses(ms, paid, today) : ms.map((m) => ({ milestone: m, paid: 0, remaining: m.amountPaise, status: null })),
  };
}

// ---------------------------------------------------------------------------
// Payables (PAY-06) and reminders (PAY-05, BGT-04 daily approval reminders)
// ---------------------------------------------------------------------------

export type PayableRow = {
  milestoneId: string;
  bookingId: string;
  vendorId: string;
  vendorName: string;
  kind: PaymentMilestone["kind"];
  label: string | null;
  dueDate: string | null;
  amount: number;
  remaining: number;
  status: Exclude<PayStatus, "paid">;
  payer: PaymentMilestone["payer"];
};

/** Unpaid milestones of confirmed bookings due by `until` (or overdue), sorted by due date. */
export async function payables(db: Tx, eventId: string, today: string, until: string | null): Promise<PayableRow[]> {
  const rows = await db
    .select({ m: paymentMilestones, vendorId: vendors.id, vendorName: vendors.name })
    .from(paymentMilestones)
    .innerJoin(bookings, eq(bookings.id, paymentMilestones.bookingId))
    .innerJoin(vendors, eq(vendors.id, bookings.vendorId))
    .where(and(eq(paymentMilestones.eventId, eventId), eq(bookings.status, "confirmed")))
    .orderBy(asc(paymentMilestones.bookingId), asc(paymentMilestones.sortOrder));
  const bookingIds = [...new Set(rows.map((r) => r.m.bookingId))];
  const paid = bookingIds.length
    ? await db
        .select({ bookingId: payments.bookingId, total: sql<number>`sum(${payments.amountPaise})::bigint`.mapWith(Number) })
        .from(payments)
        .where(and(inArray(payments.bookingId, bookingIds), eq(payments.state, "confirmed")))
        .groupBy(payments.bookingId)
    : [];
  const out: PayableRow[] = [];
  for (const id of bookingIds) {
    const ms = rows.filter((r) => r.m.bookingId === id);
    const st = milestoneStatuses(ms.map((r) => r.m), paid.find((p) => p.bookingId === id)?.total ?? 0, today);
    st.forEach((s, i) => {
      if (s.status === "paid") return;
      if (until && s.milestone.dueDate && s.milestone.dueDate > until && s.status !== "overdue") return;
      out.push({
        milestoneId: s.milestone.id,
        bookingId: id,
        vendorId: ms[i].vendorId,
        vendorName: ms[i].vendorName,
        kind: s.milestone.kind,
        label: s.milestone.label,
        dueDate: s.milestone.dueDate,
        amount: s.milestone.amountPaise,
        remaining: s.remaining,
        status: s.status,
        payer: s.milestone.payer,
      });
    });
  }
  return out.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || a.vendorName.localeCompare(b.vendorName));
}

async function recipients(db: Tx, eventId: string, roles: ("host" | "planner")[]) {
  const rows = await db
    .select({ user: users, identifier: userIdentifiers })
    .from(eventMembers)
    .innerJoin(users, eq(users.id, eventMembers.userId))
    .innerJoin(userIdentifiers, eq(userIdentifiers.userId, users.id))
    .where(and(eq(eventMembers.eventId, eventId), inArray(eventMembers.role, roles), isNull(users.suspendedAt)));
  const byUser = new Map<string, { user: (typeof rows)[number]["user"]; email?: string; phone?: string }>();
  for (const r of rows) {
    const e = byUser.get(r.user.id) ?? { user: r.user };
    if (r.identifier.type === "email") e.email ??= r.identifier.value;
    else e.phone ??= r.identifier.value;
    byUser.set(r.user.id, e);
  }
  return [...byUser.values()];
}

async function deliver(db: Tx, to: { email?: string; phone?: string }, subject: string, text: string) {
  const target = to.email ? { channel: "email" as const, to: to.email } : to.phone ? { channel: "sms" as const, to: to.phone } : null;
  if (!target) return false;
  try {
    await sendMessage(db, { ...target, subject, text });
    return true;
  } catch (err) {
    if (err instanceof DeliveryError) {
      console.error("Reminder failed", err);
      return false;
    }
    throw err;
  }
}

/**
 * Daily (PAY-05): milestones due in 3 days, due today, or overdue (weekly), to the event's
 * chosen recipients. Each milestone is reminded at most once a day.
 */
export async function sendPaymentReminders(db: Database, now = new Date(), appUrl?: string) {
  const base = linkBase(appUrl);
  const evs = await db.select().from(events).where(isNull(events.deletedAt));
  let sent = 0;
  for (const ev of evs) {
    const today = todayIn(ev.timezone, now);
    const rows = (await payables(db, ev.id, today, null)).filter((r) => {
      if (!r.dueDate) return false;
      const d = dayNum(r.dueDate) - dayNum(today);
      return d === 3 || d === 0 || (d < 0 && -d % 7 === 1);
    });
    if (rows.length === 0) continue;
    const fresh = await db
      .select({ id: paymentMilestones.id })
      .from(paymentMilestones)
      .where(and(inArray(paymentMilestones.id, rows.map((r) => r.milestoneId)), or(isNull(paymentMilestones.lastRemindedOn), lt(paymentMilestones.lastRemindedOn, today))));
    const todo = rows.filter((r) => fresh.some((f) => f.id === r.milestoneId));
    if (todo.length === 0) continue;
    const people = await recipients(db, ev.id, ev.paymentRemindersTo === "hosts" ? ["host"] : ["host", "planner"]);
    for (const p of people) {
      const locale = isLocale(p.user.locale) ? p.user.locale : "en";
      const t = createTranslator(locale);
      const lines = todo.map((r) => `• ${r.vendorName}: ${formatInr(locale, r.remaining)} (${t(`payments.status.${r.status}`)}, ${r.dueDate})`);
      if (await deliver(db, p, t("payments.reminderSubject", { event: ev.name }), `${t("payments.reminderIntro")}\n${lines.join("\n")}\n${base}/events/${ev.id}/budget/payables`)) sent++;
    }
    await db.update(paymentMilestones).set({ lastRemindedOn: today }).where(inArray(paymentMilestones.id, todo.map((r) => r.milestoneId)));
  }
  return sent;
}

/** Daily (BGT-04): Hosts get one reminder per event about requests waiting more than 24 hours. */
export async function sendApprovalReminders(db: Database, now = new Date(), appUrl?: string) {
  const base = linkBase(appUrl);
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const rows = await db
    .select({ request: approvalRequests, event: events })
    .from(approvalRequests)
    .innerJoin(events, eq(events.id, approvalRequests.eventId))
    .where(
      and(
        eq(approvalRequests.status, "pending"),
        isNull(events.deletedAt),
        lt(approvalRequests.createdAt, dayAgo),
        or(isNull(approvalRequests.lastRemindedAt), lt(approvalRequests.lastRemindedAt, dayAgo)),
      ),
    );
  const byEvent = new Map<string, typeof rows>();
  for (const r of rows) byEvent.set(r.event.id, [...(byEvent.get(r.event.id) ?? []), r]);
  let sent = 0;
  for (const [eventId, items] of byEvent) {
    const hosts = await recipients(db, eventId, ["host"]);
    for (const h of hosts) {
      const locale = isLocale(h.user.locale) ? h.user.locale : "en";
      const t = createTranslator(locale);
      const text = `${t("approvals.reminderIntro", { count: items.length })}\n${items.map((i) => `• ${i.request.title}`).join("\n")}\n${base}/events/${eventId}/approvals`;
      if (await deliver(db, h, t("approvals.reminderSubject", { event: items[0].event.name }), text)) sent++;
    }
    await db.update(approvalRequests).set({ lastRemindedAt: now }).where(inArray(approvalRequests.id, items.map((i) => i.request.id)));
  }
  return sent;
}
