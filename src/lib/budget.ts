import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  approvalRequests,
  bookings,
  budgetLines,
  fulfilments,
  functions,
  invoiceLines,
  invoices,
  payments,
  requirements,
  serviceTypes,
  services,
  type Payer,
} from "@/db/schema";
import { ApprovalError, refreshOpenRequest, stagedResult, registerApprovalHandler, submitChangeTx, type SubmitResult } from "./approvals";
import { audit, type Actor } from "./audit";
import { getServiceType } from "./catalogue";
import { allocate, gstFor } from "./money";
import { decide, ForbiddenError, type PolicySubject } from "./policy";
import { payerSchema } from "./services";

export class BudgetError extends Error {
  constructor(public code: "not_found" | "invalid" | "has_payments") {
    super(code);
  }
}

type Ctx = { eventId: string; actor: Actor; subject: PolicySubject };

// ---------------------------------------------------------------------------
// Category totals, thresholds and overspend (BGT-04, ADR-0017)
// ---------------------------------------------------------------------------

/** Planned and committed per category (service type), in paise incl. GST for commitments. */
export async function categoryTotals(db: Tx, eventId: string) {
  const planned = new Map<string, number>();
  const committed = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  const reqs = await db
    .select({ categoryId: services.serviceTypeId, estimate: requirements.estimatePaise })
    .from(requirements)
    .innerJoin(services, eq(services.id, requirements.serviceId))
    .where(
      and(
        eq(requirements.eventId, eventId),
        eq(requirements.approvalState, "approved"),
        ne(requirements.lifecycle, "cancelled"),
        eq(services.approvalState, "approved"),
        isNull(services.cancelledAt),
      ),
    );
  for (const r of reqs) add(planned, r.categoryId, r.estimate ?? 0);
  const lines = await db
    .select({ categoryId: budgetLines.categoryId, estimate: budgetLines.estimatePaise })
    .from(budgetLines)
    .where(and(eq(budgetLines.eventId, eventId), eq(budgetLines.approvalState, "approved")));
  for (const l of lines) add(planned, l.categoryId, l.estimate);
  const fs = await db
    .select({ categoryId: services.serviceTypeId, amount: fulfilments.amountPaise, gst: fulfilments.gstPaise })
    .from(fulfilments)
    .innerJoin(bookings, eq(bookings.id, fulfilments.bookingId))
    .innerJoin(services, eq(services.id, fulfilments.serviceId))
    .where(and(eq(fulfilments.eventId, eventId), eq(bookings.status, "confirmed"), isNull(fulfilments.cancelledAt)));
  for (const f of fs) add(committed, f.categoryId, f.amount + f.gst);
  return { planned, committed };
}

/**
 * Whether a Planner's money change may apply without a Host: every category's added amount
 * is strictly below its threshold (default 0, so never), and nothing goes over plan.
 */
export async function canAutoApprove(db: Tx, eventId: string, additions: Map<string, number>, opts: { checkOverspend: boolean }) {
  if (additions.size === 0) return false;
  // Serialise money auto-approvals per event so two concurrent changes can't both slip under plan.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`money:${eventId}`}))`);
  const ids = [...additions.keys()];
  const cats = await db.select().from(serviceTypes).where(and(eq(serviceTypes.eventId, eventId), inArray(serviceTypes.id, ids)));
  for (const [id, amount] of additions) {
    const c = cats.find((x) => x.id === id);
    if (!c) return false;
    // A ₹0 limit (the default) means every change needs a Host, including reductions (BGT-04).
    if (c.autoApproveBelowPaise <= 0) return false;
    if (amount > 0 && !(amount < c.autoApproveBelowPaise)) return false;
  }
  if (opts.checkOverspend && (await overspendFor(db, eventId, additions)).length) return false;
  return true;
}

/** Categories that would go over their planned total with these extra commitments. */
export async function overspendFor(db: Tx, eventId: string, additions: Map<string, number>) {
  const { planned, committed } = await categoryTotals(db, eventId);
  const over: { categoryId: string; overBy: number }[] = [];
  for (const [id, add] of additions) {
    if (add <= 0) continue;
    const after = (committed.get(id) ?? 0) + add;
    const plan = planned.get(id) ?? 0;
    if (after > plan) over.push({ categoryId: id, overBy: after - plan });
  }
  return over;
}

// ---------------------------------------------------------------------------
// Standalone budget lines (BGT-02)
// ---------------------------------------------------------------------------

export const budgetLineSchema = z.object({
  categoryId: z.string().uuid(),
  functionId: z.string().uuid().nullable(),
  title: z.string().trim().min(1).max(200),
  estimatePaise: z.number().int().min(0).max(1e13),
  payer: payerSchema.nullable(),
  notes: z.string().trim().max(2000).nullable(),
});
export type BudgetLineInput = z.infer<typeof budgetLineSchema>;

async function lockLine(tx: Tx, eventId: string, id: string) {
  const [l] = await tx.select().from(budgetLines).where(and(eq(budgetLines.id, id), eq(budgetLines.eventId, eventId))).for("update");
  if (!l) throw new BudgetError("not_found");
  return l;
}

async function checkRefs(tx: Tx, eventId: string, input: BudgetLineInput) {
  await getServiceType(tx, eventId, input.categoryId).catch(() => {
    throw new BudgetError("invalid");
  });
  if (input.functionId) {
    const [f] = await tx.select({ id: functions.id }).from(functions).where(and(eq(functions.id, input.functionId), eq(functions.eventId, eventId)));
    if (!f) throw new BudgetError("invalid");
  }
}

export async function addBudgetLine(db: Database, ctx: Ctx, input: BudgetLineInput): Promise<SubmitResult> {
  const decision = decide(ctx.subject, "budget.edit");
  if (decision === "deny") throw new ForbiddenError("budget.edit");
  return db.transaction(async (tx) => {
    await checkRefs(tx, ctx.eventId, input);
    const [line] = await tx
      .insert(budgetLines)
      .values({ eventId: ctx.eventId, ...input, approvalState: decision === "allow" ? "approved" : "proposed", createdBy: ctx.actor.userId })
      .returning();
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "budget_line.create",
      title: line.title,
      payload: { budgetLineId: line.id, version: line.version },
      amountPaise: line.estimatePaise,
      entityType: "budget_line",
      entityId: line.id,
      functionIds: line.functionId ? [line.functionId] : [],
    });
  });
}

export async function updateBudgetLine(db: Database, ctx: Ctx, id: string, input: BudgetLineInput): Promise<SubmitResult> {
  const decision = decide(ctx.subject, "budget.edit");
  if (decision === "deny") throw new ForbiddenError("budget.edit");
  return db.transaction(async (tx) => {
    const line = await lockLine(tx, ctx.eventId, id);
    await checkRefs(tx, ctx.eventId, input);
    if (line.approvalState === "rejected") throw new BudgetError("not_found");
    if (line.approvalState === "proposed") {
      await tx.update(budgetLines).set({ ...input, version: line.version + 1, updatedAt: new Date() }).where(eq(budgetLines.id, id));
      // Re-send the open request with the new values, so the Host approves what they see.
      return stagedResult(
        await refreshOpenRequest(tx, {
          eventId: ctx.eventId,
          entityType: "budget_line",
          entityId: id,
          actor: ctx.actor,
          payload: { budgetLineId: id, version: line.version + 1 },
          amountPaise: input.estimatePaise,
          title: input.title,
        }),
      );
    }
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "budget_line.update",
      title: line.title,
      payload: { budgetLineId: id, baseVersion: line.version, changes: input },
      amountPaise: input.estimatePaise - line.estimatePaise,
      entityType: "budget_line",
      entityId: id,
      functionIds: [input.functionId, line.functionId].filter((x): x is string => !!x),
    });
  });
}

export async function deleteBudgetLine(db: Database, ctx: Ctx, id: string): Promise<SubmitResult> {
  const decision = decide(ctx.subject, "budget.edit");
  if (decision === "deny") throw new ForbiddenError("budget.edit");
  return db.transaction(async (tx) => {
    const line = await lockLine(tx, ctx.eventId, id);
    const [paid] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.budgetLineId, id)).limit(1);
    if (paid) throw new BudgetError("has_payments");
    if (line.approvalState !== "approved") {
      await tx.delete(budgetLines).where(eq(budgetLines.id, id));
      await tx
        .update(approvalRequests)
        .set({ status: "cancelled", decidedAt: new Date() })
        .where(and(eq(approvalRequests.entityId, id), inArray(approvalRequests.status, ["pending", "changes_requested"])));
      return { status: "applied" } as const;
    }
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "budget_line.delete",
      title: line.title,
      payload: { budgetLineId: id },
      amountPaise: -line.estimatePaise,
      entityType: "budget_line",
      entityId: id,
      functionIds: line.functionId ? [line.functionId] : [],
    });
  });
}

const lineId = z.object({ budgetLineId: z.string().uuid() }).passthrough();

registerApprovalHandler("budget_line.create", {
  permission: "budget.edit",
  async apply(tx, payload, { eventId }) {
    const { budgetLineId, version } = lineId.extend({ version: z.number().int().optional() }).parse(payload);
    const l = await lockLine(tx, eventId, budgetLineId);
    if (l.approvalState === "approved") return;
    if (l.approvalState !== "proposed") throw new ApprovalError("stale");
    if (version !== undefined && version !== l.version) throw new ApprovalError("stale");
    await tx.update(budgetLines).set({ approvalState: "approved", updatedAt: new Date() }).where(eq(budgetLines.id, l.id));
  },
  async onClosed(tx, payload, { eventId }) {
    const { budgetLineId } = lineId.parse(payload);
    const l = await lockLine(tx, eventId, budgetLineId).catch(() => null);
    if (l?.approvalState === "proposed") await tx.update(budgetLines).set({ approvalState: "rejected" }).where(eq(budgetLines.id, l.id));
  },
  async autoApprove(tx, payload, eventId) {
    const { budgetLineId } = lineId.parse(payload);
    const l = await lockLine(tx, eventId, budgetLineId);
    return canAutoApprove(tx, eventId, new Map([[l.categoryId, l.estimatePaise]]), { checkOverspend: false });
  },
});

const linePayload = z.object({ budgetLineId: z.string().uuid(), baseVersion: z.number().int(), changes: budgetLineSchema });

registerApprovalHandler("budget_line.update", {
  permission: "budget.edit",
  async apply(tx, payload, { eventId }) {
    const p = linePayload.parse(payload);
    const l = await lockLine(tx, eventId, p.budgetLineId);
    if (l.version !== p.baseVersion) throw new ApprovalError("stale");
    await tx.update(budgetLines).set({ ...p.changes, version: l.version + 1, updatedAt: new Date() }).where(eq(budgetLines.id, l.id));
  },
  async autoApprove(tx, payload, eventId) {
    const p = linePayload.parse(payload);
    const l = await lockLine(tx, eventId, p.budgetLineId);
    if (p.changes.categoryId !== l.categoryId) return false;
    return canAutoApprove(tx, eventId, new Map([[l.categoryId, p.changes.estimatePaise - l.estimatePaise]]), { checkOverspend: false });
  },
});

registerApprovalHandler("budget_line.delete", {
  permission: "budget.edit",
  async apply(tx, payload, { eventId, actor }) {
    const { budgetLineId } = lineId.parse(payload);
    const l = await lockLine(tx, eventId, budgetLineId).catch(() => null);
    if (!l) return;
    const [paid] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.budgetLineId, l.id)).limit(1);
    if (paid) throw new ApprovalError("stale");
    await tx.delete(budgetLines).where(eq(budgetLines.id, l.id));
    await audit(tx, { eventId, actor, action: "budget_line.deleted", entityType: "budget_line", entityId: l.id, data: { title: l.title } });
  },
});

// ---------------------------------------------------------------------------
// Rollup (BGT-01/02/05): planned, committed, invoiced, paid by function, category, vendor, payer
// ---------------------------------------------------------------------------

export type Measures = { planned: number; pending: number; committed: number; invoiced: number; paid: number };
export type Fact = Measures & {
  functionId: string | null;
  categoryId: string | null;
  serviceId: string | null;
  requirementId: string | null;
  budgetLineId: string | null;
  vendorId: string | null;
  /** Whose payer label applies (service, requirement or budget line) and the label itself. */
  payerKey: string;
  payer: Payer | null;
};

const zero = (): Measures => ({ planned: 0, pending: 0, committed: 0, invoiced: 0, paid: 0 });

/** All money facts for an event. Committed/invoiced/paid include GST. */
export async function budgetFacts(db: Tx, eventId: string): Promise<Fact[]> {
  const facts: Fact[] = [];
  const svc = await db
    .select({ s: services })
    .from(services)
    .where(and(eq(services.eventId, eventId), ne(services.approvalState, "rejected")));
  const svcById = new Map(svc.map(({ s }) => [s.id, s]));
  const reqs = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.eventId, eventId), ne(requirements.approvalState, "rejected")));
  const reqById = new Map(reqs.map((r) => [r.id, r]));
  const base = (serviceId: string | null, requirementId: string | null) => {
    const s = serviceId ? svcById.get(serviceId) : undefined;
    const r = requirementId ? reqById.get(requirementId) : undefined;
    return {
      functionId: s?.functionId ?? null,
      categoryId: s?.serviceTypeId ?? null,
      serviceId: s?.id ?? null,
      requirementId: r?.id ?? null,
      budgetLineId: null,
      payerKey: r?.payer ? `r:${r.id}` : s ? `s:${s.id}` : "none",
      payer: r?.payer ?? s?.payer ?? null,
    };
  };

  // Planned and pending proposals
  for (const r of reqs) {
    const s = svcById.get(r.serviceId);
    if (!s) continue;
    const live = r.lifecycle !== "cancelled" && !s.cancelledAt;
    if (!live || !r.estimatePaise) continue;
    const approved = r.approvalState === "approved" && s.approvalState === "approved";
    facts.push({ ...zero(), ...base(s.id, r.id), vendorId: null, planned: approved ? r.estimatePaise : 0, pending: approved ? 0 : r.estimatePaise });
  }
  const pendingEdits = await db
    .select({ entityId: approvalRequests.entityId, entityType: approvalRequests.entityType, amount: approvalRequests.amountPaise })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.eventId, eventId),
        eq(approvalRequests.status, "pending"),
        inArray(approvalRequests.type, ["requirement.update", "requirement.cancel", "budget_line.update", "budget_line.delete"]),
      ),
    );
  const lines = await db.select().from(budgetLines).where(and(eq(budgetLines.eventId, eventId), ne(budgetLines.approvalState, "rejected")));
  const lineFact = (l: (typeof lines)[number]) => ({
    functionId: l.functionId,
    categoryId: l.categoryId,
    serviceId: null,
    requirementId: null,
    budgetLineId: l.id,
    vendorId: null,
    payerKey: `b:${l.id}`,
    payer: l.payer,
  });
  for (const l of lines) {
    facts.push({ ...zero(), ...lineFact(l), planned: l.approvalState === "approved" ? l.estimatePaise : 0, pending: l.approvalState === "approved" ? 0 : l.estimatePaise });
  }
  for (const e of pendingEdits) {
    if (!e.amount || !e.entityId) continue;
    if (e.entityType === "requirement") {
      const r = reqById.get(e.entityId);
      if (r) facts.push({ ...zero(), ...base(r.serviceId, r.id), vendorId: null, pending: e.amount });
    } else {
      const l = lines.find((x) => x.id === e.entityId);
      if (l) facts.push({ ...zero(), ...lineFact(l), pending: e.amount });
    }
  }

  // Committed: confirmed bookings' active fulfilments
  const fs = await db
    .select({ f: fulfilments, vendorId: bookings.vendorId, bookingId: bookings.id })
    .from(fulfilments)
    .innerJoin(bookings, eq(bookings.id, fulfilments.bookingId))
    .where(and(eq(fulfilments.eventId, eventId), eq(bookings.status, "confirmed"), isNull(fulfilments.cancelledAt)));
  for (const { f, vendorId } of fs) facts.push({ ...zero(), ...base(f.serviceId, f.requirementId), vendorId, committed: f.amountPaise + f.gstPaise });

  // Spreads an amount over a booking's services by their committed share.
  const byBooking = new Map<string, { serviceId: string; requirementId: string | null; weight: number }[]>();
  for (const { f, bookingId } of fs) byBooking.set(bookingId, [...(byBooking.get(bookingId) ?? []), { serviceId: f.serviceId, requirementId: f.requirementId, weight: f.amountPaise + f.gstPaise }]);
  const spread = (bookingId: string, amount: number, vendorId: string, key: "invoiced" | "paid", payer: Payer | null, payerKey?: string) => {
    const parts = byBooking.get(bookingId);
    if (!parts?.length) {
      facts.push({ ...zero(), functionId: null, categoryId: null, serviceId: null, requirementId: null, budgetLineId: null, vendorId, payerKey: "none", payer, [key]: amount });
      return;
    }
    const split = allocate(amount, parts.map((p) => Math.max(0, p.weight)));
    parts.forEach((p, i) => {
      const b = base(p.serviceId, p.requirementId);
      facts.push({ ...zero(), ...b, vendorId, payer: payer ?? b.payer, payerKey: payer ? (payerKey ?? `p:${bookingId}`) : b.payerKey, [key]: split[i] });
    });
  };

  // Invoiced: lines on a service go there; others spread over the invoice's booking.
  const inv = await db
    .select({ line: invoiceLines, invoice: invoices })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(eq(invoiceLines.eventId, eventId));
  for (const { line, invoice } of inv) {
    const amount = gstFor(line.amountPaise, line.gstRateBps, invoice.taxType).total;
    if (line.serviceId && svcById.has(line.serviceId)) facts.push({ ...zero(), ...base(line.serviceId, null), vendorId: invoice.vendorId, invoiced: amount });
    else if (invoice.bookingId) spread(invoice.bookingId, amount, invoice.vendorId, "invoiced", null);
    else facts.push({ ...zero(), functionId: null, categoryId: null, serviceId: null, requirementId: null, budgetLineId: null, vendorId: invoice.vendorId, payerKey: "none", payer: null, invoiced: amount });
  }

  // Paid: confirmed payments only
  const pays = await db
    .select({ p: payments, vendorId: bookings.vendorId })
    .from(payments)
    .leftJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(eq(payments.eventId, eventId), eq(payments.state, "confirmed")));
  for (const { p, vendorId } of pays) {
    // Each payment keeps its own payer label: the advance may come from one family, the rest from the other.
    if (p.bookingId && vendorId) spread(p.bookingId, p.amountPaise, vendorId, "paid", p.payer, `pay:${p.id}`);
    else if (p.budgetLineId) {
      const l = lines.find((x) => x.id === p.budgetLineId);
      if (l) facts.push({ ...zero(), ...lineFact(l), payer: p.payer ?? l.payer, payerKey: p.payer ? `pay:${p.id}` : `b:${l.id}`, paid: p.amountPaise });
    }
  }
  return facts;
}

export function sumFacts(facts: Fact[]): Measures {
  const m = zero();
  for (const f of facts) {
    m.planned += f.planned;
    m.pending += f.pending;
    m.committed += f.committed;
    m.invoiced += f.invoiced;
    m.paid += f.paid;
  }
  return m;
}

export function groupFacts<K extends keyof Fact>(facts: Fact[], key: K): Map<Fact[K], Measures> {
  const out = new Map<Fact[K], Measures>();
  for (const f of facts) {
    const m = out.get(f[key]) ?? zero();
    m.planned += f.planned;
    m.pending += f.pending;
    m.committed += f.committed;
    m.invoiced += f.invoiced;
    m.paid += f.paid;
    out.set(f[key], m);
  }
  return out;
}

const MEASURES = ["planned", "pending", "committed", "invoiced", "paid"] as const;

/** Splits one payer label's amounts between the families (BGT-03). Fixed splits cap at the amount. */
export function splitPayer(m: Measures, payer: Payer | null): { bride: Measures; groom: Measures; unassigned: Measures } {
  const bride = zero();
  const groom = zero();
  const unassigned = zero();
  for (const k of MEASURES) {
    const v = m[k];
    if (!payer) unassigned[k] = v;
    else if (payer.kind === "bride") bride[k] = v;
    else if (payer.kind === "groom") groom[k] = v;
    else if (payer.mode === "percent") {
      const [b, g] = allocate(v, [payer.brideBps, 10_000 - payer.brideBps]);
      bride[k] = b;
      groom[k] = g;
    } else {
      const b = v <= 0 ? v : Math.min(payer.bridePaise, v);
      bride[k] = b;
      groom[k] = v - b;
    }
  }
  return { bride, groom, unassigned };
}

/** By payer: totals per family; always adds up to the event total. */
export function byPayer(facts: Fact[]) {
  const groups = new Map<string, { payer: Payer | null; facts: Fact[] }>();
  for (const f of facts) {
    const g = groups.get(f.payerKey) ?? { payer: f.payer, facts: [] };
    g.facts.push(f);
    groups.set(f.payerKey, g);
  }
  const out = { bride: zero(), groom: zero(), unassigned: zero() };
  for (const g of groups.values()) {
    const s = splitPayer(sumFacts(g.facts), g.payer);
    for (const side of ["bride", "groom", "unassigned"] as const) for (const k of MEASURES) out[side][k] += s[side][k];
  }
  return out;
}
