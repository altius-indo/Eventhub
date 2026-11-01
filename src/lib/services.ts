import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  approvalRequests,
  bookings,
  eventMembers,
  fulfilments,
  functions,
  quoteLines,
  quoteRequests,
  quoteRequestServices,
  requirements,
  serviceTypes,
  services,
  type Payer,
  type Requirement,
  type Service,
} from "@/db/schema";
import { ApprovalError, refreshOpenRequest, registerApprovalHandler, submitChangeTx, type SubmitResult } from "./approvals";
import { audit, type Actor } from "./audit";
import { bookingsOf, recalcBookingTotals } from "./booking-totals";
import { getServiceType } from "./catalogue";
import { decide, ForbiddenError, type PolicySubject } from "./policy";
import { addMinutes, parseWallClock } from "./wall-clock";

export class ServiceError extends Error {
  constructor(public code: "not_found" | "not_approved" | "cancelled" | "has_bookings" | "invalid" | "not_owner") {
    super(code);
  }
}

export const payerSchema = z.union([
  z.object({ kind: z.literal("bride") }),
  z.object({ kind: z.literal("groom") }),
  z.object({ kind: z.literal("shared"), mode: z.literal("percent"), brideBps: z.number().int().min(0).max(10_000) }),
  z.object({ kind: z.literal("shared"), mode: z.literal("fixed"), bridePaise: z.number().int().min(0) }),
]);

/** Form value -> Payer ("bride" | "groom" | "shared" with percent or fixed rupees); undefined = invalid. */
export function payerFromForm(kind: string, splitMode: string, splitValue: string): Payer | null | undefined {
  if (kind === "bride" || kind === "groom") return { kind };
  if (kind !== "shared") return null;
  const v = splitValue.trim().replace(/[₹,%\s]/g, "");
  if (splitMode === "fixed") {
    if (!/^\d{1,11}(\.\d{1,2})?$/.test(v)) return undefined;
    const [r, p = ""] = v.split(".");
    return { kind: "shared", mode: "fixed", bridePaise: Number(r) * 100 + Number(p.padEnd(2, "0")) };
  }
  if (v === "") return { kind: "shared", mode: "percent", brideBps: 5000 };
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return undefined;
  const pct = Number(v);
  if (pct > 100) return undefined;
  return { kind: "shared", mode: "percent", brideBps: Math.round(pct * 100) };
}

export const requirementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(0).max(1_000_000).nullable(),
  unit: z.string().trim().max(40).nullable(),
  specs: z.string().trim().max(4000).nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  venue: z.string().trim().max(300).nullable(),
  estimatePaise: z.number().int().min(0).max(1e13).nullable(),
  priority: z.enum(["must", "nice"]),
  payer: payerSchema.nullable(),
});
export type RequirementInput = z.infer<typeof requirementSchema>;

type Ctx = { eventId: string; actor: Actor; subject: PolicySubject };

function toRow(input: RequirementInput) {
  return {
    title: input.title,
    quantity: input.quantity,
    unit: input.unit || null,
    specs: input.specs || null,
    startsAt: input.startsAt ? parseWallClock(input.startsAt) : null,
    endsAt: input.endsAt ? parseWallClock(input.endsAt) : null,
    venue: input.venue || null,
    estimatePaise: input.estimatePaise,
    priority: input.priority,
    payer: input.payer,
  };
}

async function lockService(tx: Tx, eventId: string, serviceId: string) {
  const [s] = await tx
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.eventId, eventId)))
    .for("update");
  if (!s) throw new ServiceError("not_found");
  return s;
}

async function lockRequirement(tx: Tx, eventId: string, requirementId: string) {
  const [r] = await tx
    .select()
    .from(requirements)
    .where(and(eq(requirements.id, requirementId), eq(requirements.eventId, eventId)))
    .for("update");
  if (!r) throw new ServiceError("not_found");
  return r;
}

async function functionOf(tx: Tx, eventId: string, functionId: string) {
  const [f] = await tx.select().from(functions).where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)));
  if (!f) throw new ServiceError("not_found");
  return f;
}

async function assertMember(tx: Tx, eventId: string, userId: string | null) {
  if (!userId) return;
  const [m] = await tx.select({ id: eventMembers.id }).from(eventMembers).where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, userId)));
  if (!m) throw new ServiceError("invalid");
}

const titleFor = (fnName: string, typeName: string, extra?: string) => [fnName, typeName, extra].filter(Boolean).join(" · ");

/**
 * Adds a service to a function (SVC-02), pre-filled with the type's requirement templates.
 * A Planner's service and its requirements stay "proposed" until a Host approves (SVC-10).
 */
export async function addService(
  db: Database,
  ctx: Ctx,
  input: { functionId: string; serviceTypeId: string; name?: string | null; ownerUserId?: string | null; brief?: string | null; payer?: Payer | null; useTemplates?: boolean },
): Promise<{ service: Service; result: SubmitResult }> {
  const decision = decide(ctx.subject, "services.edit");
  if (decision === "deny") throw new ForbiddenError("services.edit");
  return db.transaction(async (tx) => {
    const fn = await functionOf(tx, ctx.eventId, input.functionId);
    const type = await getServiceType(tx, ctx.eventId, input.serviceTypeId);
    if (type.kind !== "service") throw new ServiceError("invalid");
    await assertMember(tx, ctx.eventId, input.ownerUserId ?? null);
    const state: "approved" | "proposed" = decision === "allow" ? "approved" : "proposed";
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(services).where(eq(services.functionId, fn.id));
    const [service] = await tx
      .insert(services)
      .values({
        eventId: ctx.eventId,
        functionId: fn.id,
        serviceTypeId: type.id,
        name: input.name?.trim() || null,
        ownerUserId: input.ownerUserId ?? null,
        brief: input.brief?.trim() || null,
        payer: input.payer ?? null,
        approvalState: state,
        sortOrder: n + 1,
        createdBy: ctx.actor.userId,
      })
      .returning();
    if (input.useTemplates !== false && type.requirementTemplates.length) {
      await tx.insert(requirements).values(
        type.requirementTemplates.map((tpl, i) => ({
          eventId: ctx.eventId,
          serviceId: service.id,
          title: tpl.title,
          unit: tpl.unit ?? null,
          quantity: tpl.quantity ?? null,
          specs: tpl.specs ?? null,
          approvalState: state,
          sortOrder: i + 1,
          createdBy: ctx.actor.userId,
        })),
      );
    }
    const result = await submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "service.create",
      title: titleFor(fn.name, service.name ?? type.name),
      payload: { serviceId: service.id, version: service.version },
      entityType: "service",
      entityId: service.id,
      functionIds: [fn.id],
    });
    return { service, result };
  });
}

/** Owner, brief, label and payer are not material (no approval needed): SVC-03, BGT-03. */
export async function updateServiceDetails(
  db: Database,
  ctx: Ctx,
  serviceId: string,
  input: { name: string | null; ownerUserId: string | null; brief: string | null; payer: Payer | null },
) {
  if (decide(ctx.subject, "services.edit") === "deny") throw new ForbiddenError("services.edit");
  await db.transaction(async (tx) => {
    const s = await lockService(tx, ctx.eventId, serviceId);
    if (s.approvalState === "rejected") throw new ServiceError("not_found");
    await assertMember(tx, ctx.eventId, input.ownerUserId);
    await tx
      .update(services)
      .set({ name: input.name?.trim() || null, ownerUserId: input.ownerUserId, brief: input.brief?.trim() || null, payer: input.payer, updatedAt: new Date() })
      .where(eq(services.id, s.id));
    if (JSON.stringify(s.payer) !== JSON.stringify(input.payer) || s.ownerUserId !== input.ownerUserId) {
      await audit(tx, { eventId: ctx.eventId, actor: ctx.actor, action: "service.details_changed", entityType: "service", entityId: s.id, data: { payer: input.payer?.kind ?? null } });
    }
  });
}

export async function addRequirement(db: Database, ctx: Ctx, serviceId: string, input: RequirementInput) {
  const decision = decide(ctx.subject, "services.edit");
  if (decision === "deny") throw new ForbiddenError("services.edit");
  return db.transaction(async (tx) => {
    const s = await lockService(tx, ctx.eventId, serviceId);
    if (s.approvalState === "rejected" || s.cancelledAt) throw new ServiceError("cancelled");
    const fn = await functionOf(tx, ctx.eventId, s.functionId);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(requirements).where(eq(requirements.serviceId, s.id));
    // Requirements added to a still-proposed service ride along with the service's own request.
    const state: "approved" | "proposed" = decision === "allow" ? "approved" : "proposed";
    const [req] = await tx
      .insert(requirements)
      .values({ eventId: ctx.eventId, serviceId: s.id, ...toRow(input), approvalState: state, sortOrder: n + 1, createdBy: ctx.actor.userId })
      .returning();
    let result: SubmitResult = { status: "applied" };
    if (s.approvalState === "proposed") await syncServiceProposal(tx, ctx.eventId, s.id, ctx.actor);
    if (s.approvalState === "approved") {
      result = await submitChangeTx(tx, {
        eventId: ctx.eventId,
        actor: ctx.actor,
        subject: ctx.subject,
        type: "requirement.create",
        title: titleFor(fn.name, "", req.title),
        payload: { requirementId: req.id, version: req.version },
        amountPaise: req.estimatePaise,
        entityType: "requirement",
        entityId: req.id,
        functionIds: [fn.id],
      });
    }
    return { requirement: req, result };
  });
}

/**
 * Changes a requirement. Hosts apply directly; a Planner's change to an approved requirement
 * becomes a request carrying the diff and the version it was based on (ADR-0016). A Planner may
 * edit a requirement that is still proposed: the pending request then covers the edited values.
 */
export async function updateRequirement(db: Database, ctx: Ctx, requirementId: string, input: RequirementInput): Promise<SubmitResult> {
  const decision = decide(ctx.subject, "services.edit");
  if (decision === "deny") throw new ForbiddenError("services.edit");
  return db.transaction(async (tx) => {
    const r = await lockRequirement(tx, ctx.eventId, requirementId);
    if (r.approvalState === "rejected" || r.lifecycle === "cancelled") throw new ServiceError("cancelled");
    const row = toRow(input);
    if (r.approvalState === "proposed") {
      await tx.update(requirements).set({ ...row, version: r.version + 1, updatedAt: new Date() }).where(eq(requirements.id, r.id));
      // The open request (this requirement's, or its proposed service's) is re-sent with the new values.
      const [svc] = await tx.select({ approvalState: services.approvalState }).from(services).where(eq(services.id, r.serviceId));
      if (svc?.approvalState === "proposed") await syncServiceProposal(tx, ctx.eventId, r.serviceId, ctx.actor);
      else
        await refreshOpenRequest(tx, {
          eventId: ctx.eventId,
          entityType: "requirement",
          entityId: r.id,
          actor: ctx.actor,
          payload: { requirementId: r.id, version: r.version + 1 },
          amountPaise: row.estimatePaise,
          title: undefined,
        });
      return { status: "applied" } as const;
    }
    const s = await lockService(tx, ctx.eventId, r.serviceId);
    const fn = await functionOf(tx, ctx.eventId, s.functionId);
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "requirement.update",
      title: titleFor(fn.name, "", r.title),
      payload: { requirementId: r.id, baseVersion: r.version, changes: { ...input } },
      amountPaise: (input.estimatePaise ?? 0) - (r.estimatePaise ?? 0),
      entityType: "requirement",
      entityId: r.id,
      functionIds: [fn.id],
    });
  });
}

export async function cancelRequirement(db: Database, ctx: Ctx, requirementId: string, reason: string): Promise<SubmitResult> {
  const decision = decide(ctx.subject, "services.edit");
  if (decision === "deny") throw new ForbiddenError("services.edit");
  return db.transaction(async (tx) => {
    const r = await lockRequirement(tx, ctx.eventId, requirementId);
    if (r.lifecycle === "cancelled" || r.approvalState === "rejected") throw new ServiceError("cancelled");
    const s = await lockService(tx, ctx.eventId, r.serviceId);
    const fn = await functionOf(tx, ctx.eventId, s.functionId);
    if (r.approvalState === "proposed") {
      // Withdrawing a proposal: no Host decision needed.
      await tx.update(requirements).set({ approvalState: "rejected", updatedAt: new Date() }).where(eq(requirements.id, r.id));
      await closeOpenRequestsFor(tx, ctx.eventId, "requirement", r.id);
      return { status: "applied" } as const;
    }
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "requirement.cancel",
      title: titleFor(fn.name, "", r.title),
      payload: { requirementId: r.id, reason: reason.slice(0, 500) },
      amountPaise: -(r.estimatePaise ?? 0),
      entityType: "requirement",
      entityId: r.id,
      functionIds: [fn.id],
    });
  });
}

export async function cancelService(db: Database, ctx: Ctx, serviceId: string, reason: string): Promise<SubmitResult> {
  const decision = decide(ctx.subject, "services.edit");
  if (decision === "deny") throw new ForbiddenError("services.edit");
  return db.transaction(async (tx) => {
    const s = await lockService(tx, ctx.eventId, serviceId);
    if (s.cancelledAt || s.approvalState === "rejected") throw new ServiceError("cancelled");
    const fn = await functionOf(tx, ctx.eventId, s.functionId);
    if (s.approvalState === "proposed") {
      await rejectService(tx, s.id);
      await closeOpenRequestsFor(tx, ctx.eventId, "service", s.id);
      return { status: "applied" } as const;
    }
    const [type] = await tx.select({ name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.id, s.serviceTypeId));
    return submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "service.cancel",
      title: titleFor(fn.name, s.name ?? type?.name ?? ""),
      payload: { serviceId: s.id, reason: reason.slice(0, 500) },
      entityType: "service",
      entityId: s.id,
      functionIds: [fn.id],
    });
  });
}

/** Marks pending requests about a withdrawn proposal as cancelled. */
async function closeOpenRequestsFor(tx: Tx, eventId: string, entityType: string, entityId: string) {
  await tx
    .update(approvalRequests)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.eventId, eventId),
        eq(approvalRequests.entityType, entityType),
        eq(approvalRequests.entityId, entityId),
        inArray(approvalRequests.status, ["pending", "changes_requested"]),
      ),
    );
}

/** Sum of a still-proposed service's requirement estimates (its request's amount). */
async function proposedTotal(tx: Tx, serviceId: string) {
  const [{ sum }] = await tx
    .select({ sum: sql<number>`coalesce(sum(${requirements.estimatePaise}), 0)::bigint`.mapWith(Number) })
    .from(requirements)
    .where(and(eq(requirements.serviceId, serviceId), eq(requirements.approvalState, "proposed")));
  return sum;
}

/** A proposed service changed (requirements added or edited): new version, request re-sent. */
async function syncServiceProposal(tx: Tx, eventId: string, serviceId: string, actor: Actor) {
  const [s] = await tx
    .update(services)
    .set({ version: sql`${services.version} + 1`, updatedAt: new Date() })
    .where(eq(services.id, serviceId))
    .returning({ version: services.version });
  await refreshOpenRequest(tx, { eventId, entityType: "service", entityId: serviceId, actor, payload: { serviceId, version: s.version }, amountPaise: await proposedTotal(tx, serviceId) });
}

async function rejectService(tx: Tx, serviceId: string) {
  await tx.update(services).set({ approvalState: "rejected", updatedAt: new Date() }).where(eq(services.id, serviceId));
  await tx
    .update(requirements)
    .set({ approvalState: "rejected", updatedAt: new Date() })
    .where(and(eq(requirements.serviceId, serviceId), eq(requirements.approvalState, "proposed")));
}

/** Cancelling releases the commitment: active fulfilments on it are cancelled (SVC-10). */
async function cancelFulfilmentsWhere(tx: Tx, where: ReturnType<typeof eq>) {
  await tx.update(fulfilments).set({ cancelledAt: new Date() }).where(and(where, isNull(fulfilments.cancelledAt)));
}

/** SVC-08: the service owner (or a Host) marks a requirement delivered. */
export async function markDelivered(db: Database, ctx: Ctx, requirementId: string, delivered: boolean) {
  await db.transaction(async (tx) => {
    const r = await lockRequirement(tx, ctx.eventId, requirementId);
    const s = await lockService(tx, ctx.eventId, r.serviceId);
    const isOwner = s.ownerUserId === ctx.actor.userId;
    if (!isOwner && decide(ctx.subject, "services.edit") !== "allow") throw new ServiceError("not_owner");
    if (r.approvalState !== "approved" || r.lifecycle === "cancelled") throw new ServiceError("not_approved");
    await tx
      .update(requirements)
      .set({ lifecycle: delivered ? "delivered" : "open", deliveredAt: delivered ? new Date() : null, updatedAt: new Date() })
      .where(eq(requirements.id, r.id));
    await audit(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      action: delivered ? "requirement.delivered" : "requirement.undelivered",
      entityType: "requirement",
      entityId: r.id,
      data: { title: r.title },
    });
  });
}

/** SVC-09: copies a service and its live requirements to another function. */
export async function copyService(db: Database, ctx: Ctx, serviceId: string, toFunctionId: string) {
  const decision = decide(ctx.subject, "services.edit");
  if (decision === "deny") throw new ForbiddenError("services.edit");
  return db.transaction(async (tx) => {
    const s = await lockService(tx, ctx.eventId, serviceId);
    const fn = await functionOf(tx, ctx.eventId, toFunctionId);
    const reqs = await tx
      .select()
      .from(requirements)
      .where(and(eq(requirements.serviceId, s.id), ne(requirements.approvalState, "rejected"), ne(requirements.lifecycle, "cancelled")))
      .orderBy(asc(requirements.sortOrder));
    const state: "approved" | "proposed" = decision === "allow" ? "approved" : "proposed";
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(services).where(eq(services.functionId, fn.id));
    const [copy] = await tx
      .insert(services)
      .values({
        eventId: ctx.eventId,
        functionId: fn.id,
        serviceTypeId: s.serviceTypeId,
        name: s.name,
        ownerUserId: s.ownerUserId,
        brief: s.brief,
        payer: s.payer,
        approvalState: state,
        sortOrder: n + 1,
        createdBy: ctx.actor.userId,
      })
      .returning();
    if (reqs.length) {
      await tx.insert(requirements).values(
        reqs.map((r, i) => ({
          eventId: ctx.eventId,
          serviceId: copy.id,
          title: r.title,
          quantity: r.quantity,
          unit: r.unit,
          specs: r.specs,
          // Times and venue belong to the original function; the copy uses its own.
          venue: null,
          estimatePaise: r.estimatePaise,
          priority: r.priority,
          payer: r.payer,
          approvalState: state,
          sortOrder: i + 1,
          createdBy: ctx.actor.userId,
        })),
      );
    }
    const [type] = await tx.select({ name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.id, s.serviceTypeId));
    const result = await submitChangeTx(tx, {
      eventId: ctx.eventId,
      actor: ctx.actor,
      subject: ctx.subject,
      type: "service.create",
      title: titleFor(fn.name, s.name ?? type?.name ?? ""),
      payload: { serviceId: copy.id, version: copy.version },
      amountPaise: reqs.reduce((a, r) => a + (r.estimatePaise ?? 0), 0),
      entityType: "service",
      entityId: copy.id,
      functionIds: [fn.id],
    });
    return { service: copy, result };
  });
}

// ---------------------------------------------------------------------------
// Approval handlers (SVC-10)
// ---------------------------------------------------------------------------

const servicePayload = z.object({ serviceId: z.string().uuid(), version: z.number().int().optional() });
const requirementPayload = z.object({ requirementId: z.string().uuid(), version: z.number().int().optional() });

registerApprovalHandler("service.create", {
  permission: "services.edit",
  async apply(tx, payload, { eventId }) {
    const { serviceId, version } = servicePayload.parse(payload);
    const s = await lockService(tx, eventId, serviceId);
    if (s.approvalState !== "proposed") {
      if (s.approvalState === "approved") return;
      throw new ApprovalError("stale");
    }
    if (version !== undefined && version !== s.version) throw new ApprovalError("stale");
    await tx.update(services).set({ approvalState: "approved", updatedAt: new Date() }).where(eq(services.id, s.id));
    await tx
      .update(requirements)
      .set({ approvalState: "approved", updatedAt: new Date() })
      .where(and(eq(requirements.serviceId, s.id), eq(requirements.approvalState, "proposed")));
  },
  async onClosed(tx, payload, { eventId }) {
    const { serviceId } = servicePayload.parse(payload);
    const s = await lockService(tx, eventId, serviceId).catch(() => null);
    if (s && s.approvalState === "proposed") await rejectService(tx, s.id);
  },
});

registerApprovalHandler("requirement.create", {
  permission: "services.edit",
  async apply(tx, payload, { eventId }) {
    const { requirementId, version } = requirementPayload.parse(payload);
    const r = await lockRequirement(tx, eventId, requirementId);
    if (r.approvalState === "approved") return;
    if (r.approvalState !== "proposed") throw new ApprovalError("stale");
    if (version !== undefined && version !== r.version) throw new ApprovalError("stale");
    await tx.update(requirements).set({ approvalState: "approved", updatedAt: new Date() }).where(eq(requirements.id, r.id));
  },
  async onClosed(tx, payload, { eventId }) {
    const { requirementId } = requirementPayload.parse(payload);
    const r = await lockRequirement(tx, eventId, requirementId).catch(() => null);
    if (r && r.approvalState === "proposed") await tx.update(requirements).set({ approvalState: "rejected" }).where(eq(requirements.id, r.id));
  },
});

const updatePayload = z.object({ requirementId: z.string().uuid(), baseVersion: z.number().int(), changes: requirementSchema });

registerApprovalHandler("requirement.update", {
  permission: "services.edit",
  async apply(tx, payload, { eventId }) {
    const p = updatePayload.parse(payload);
    const r = await lockRequirement(tx, eventId, p.requirementId);
    if (r.version !== p.baseVersion || r.lifecycle === "cancelled") throw new ApprovalError("stale");
    await tx
      .update(requirements)
      .set({ ...toRow(p.changes), version: r.version + 1, updatedAt: new Date() })
      .where(eq(requirements.id, r.id));
  },
});

registerApprovalHandler("requirement.cancel", {
  permission: "services.edit",
  async apply(tx, payload, { eventId, actor }) {
    const { requirementId, reason } = z.object({ requirementId: z.string().uuid(), reason: z.string().default("") }).parse(payload);
    const r = await lockRequirement(tx, eventId, requirementId);
    if (r.lifecycle === "cancelled") return;
    await tx.update(requirements).set({ lifecycle: "cancelled", version: r.version + 1, updatedAt: new Date() }).where(eq(requirements.id, r.id));
    const affected = await bookingsOf(tx, { requirementId: r.id });
    await cancelFulfilmentsWhere(tx, eq(fulfilments.requirementId, r.id));
    await recalcBookingTotals(tx, affected);
    await closeOpenRequestsFor(tx, eventId, "requirement", r.id);
    await audit(tx, { eventId, actor, action: "requirement.cancelled", entityType: "requirement", entityId: r.id, data: { title: r.title, reason } });
  },
});

registerApprovalHandler("service.cancel", {
  permission: "services.edit",
  async apply(tx, payload, { eventId, actor }) {
    const { serviceId, reason } = z.object({ serviceId: z.string().uuid(), reason: z.string().default("") }).parse(payload);
    const s = await lockService(tx, eventId, serviceId);
    if (s.cancelledAt) return;
    await tx.update(services).set({ cancelledAt: new Date(), version: s.version + 1, updatedAt: new Date() }).where(eq(services.id, s.id));
    const cancelled = await tx
      .update(requirements)
      .set({ lifecycle: "cancelled", updatedAt: new Date() })
      .where(and(eq(requirements.serviceId, s.id), ne(requirements.lifecycle, "delivered")))
      .returning({ id: requirements.id });
    const affected = await bookingsOf(tx, { serviceId: s.id });
    await cancelFulfilmentsWhere(tx, eq(fulfilments.serviceId, s.id));
    await recalcBookingTotals(tx, affected);
    for (const c of cancelled) await closeOpenRequestsFor(tx, eventId, "requirement", c.id);
    await audit(tx, { eventId, actor, action: "service.cancelled", entityType: "service", entityId: s.id, data: { reason } });
  },
});

// ---------------------------------------------------------------------------
// Reads: coverage, derived status (SVC-04/06), gap view (SVC-07)
// ---------------------------------------------------------------------------

export type RequirementStatus = "proposed" | "rejected" | "cancelled" | "delivered" | "booked" | "partially_booked" | "quoting" | "open";

export type Coverage = { confirmedQty: number; tentativeQty: number; full: boolean; tentativeFull: boolean; committedPaise: number };

/** Coverage per requirement from active fulfilments (confirmed vs awaiting approval). */
export async function coverageFor(db: Tx, eventId: string, requirementIds: string[]) {
  const map = new Map<string, Coverage>();
  if (requirementIds.length === 0) return map;
  const rows = await db
    .select({
      requirementId: fulfilments.requirementId,
      quantity: fulfilments.quantity,
      amount: sql<number>`(${fulfilments.amountPaise} + ${fulfilments.gstPaise})::bigint`.mapWith(Number),
      status: bookings.status,
    })
    .from(fulfilments)
    .innerJoin(bookings, eq(bookings.id, fulfilments.bookingId))
    .where(
      and(
        eq(fulfilments.eventId, eventId),
        inArray(fulfilments.requirementId, requirementIds),
        isNull(fulfilments.cancelledAt),
        ne(bookings.status, "cancelled"),
      ),
    );
  for (const r of rows) {
    const c = map.get(r.requirementId!) ?? { confirmedQty: 0, tentativeQty: 0, full: false, tentativeFull: false, committedPaise: 0 };
    if (r.status === "confirmed") {
      if (r.quantity == null) c.full = true;
      else c.confirmedQty += r.quantity;
      c.committedPaise += r.amount;
    } else {
      if (r.quantity == null) c.tentativeFull = true;
      else c.tentativeQty += r.quantity;
    }
    map.set(r.requirementId!, c);
  }
  return map;
}

export function requirementStatus(r: Pick<Requirement, "approvalState" | "lifecycle" | "quantity">, c: Coverage | undefined, quoting: boolean): RequirementStatus {
  if (r.approvalState === "rejected") return "rejected";
  if (r.approvalState === "proposed") return "proposed";
  if (r.lifecycle === "cancelled") return "cancelled";
  if (r.lifecycle === "delivered") return "delivered";
  if (c) {
    // Without a quantity, any confirmed booking covers it.
    if (c.full || ((r.quantity == null || r.quantity === 0) && c.confirmedQty > 0)) return "booked";
    if (r.quantity != null && r.quantity > 0 && c.confirmedQty >= r.quantity) return "booked";
    if (c.confirmedQty > 0) return "partially_booked";
  }
  return quoting ? "quoting" : "open";
}

/** Services with an open quote request or any quote line ("quoting"). */
export async function quotingServiceIds(db: Tx, eventId: string): Promise<Set<string>> {
  const a = await db
    .select({ id: quoteRequestServices.serviceId })
    .from(quoteRequestServices)
    .innerJoin(quoteRequests, eq(quoteRequests.id, quoteRequestServices.requestId))
    .where(and(eq(quoteRequestServices.eventId, eventId), isNull(quoteRequests.closedAt)));
  const b = await db.selectDistinct({ id: quoteLines.serviceId }).from(quoteLines).where(eq(quoteLines.eventId, eventId));
  return new Set([...a, ...b].map((x) => x.id).filter((x): x is string => !!x));
}

export type ServiceView = Service & {
  typeName: string;
  typeKey: string | null;
  requirements: (Requirement & { status: RequirementStatus; coverage: Coverage | null; pendingChange: boolean })[];
  status: RequirementStatus | "empty";
  pendingChange: boolean;
};

/** Rolled-up service status: the "least done" live requirement (SVC-03). */
export function rollUp(statuses: RequirementStatus[]): RequirementStatus | "empty" {
  const live = statuses.filter((s) => s !== "rejected" && s !== "cancelled");
  if (live.length === 0) return "empty";
  const order: RequirementStatus[] = ["proposed", "open", "quoting", "partially_booked", "booked", "delivered"];
  return live.reduce((a, b) => (order.indexOf(a) <= order.indexOf(b) ? a : b));
}

async function pendingEntityIds(db: Tx, eventId: string) {
  const rows = await db
    .select({ entityId: approvalRequests.entityId })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.eventId, eventId), inArray(approvalRequests.status, ["pending", "changes_requested"])));
  return new Set(rows.map((r) => r.entityId).filter((x): x is string => !!x));
}

/** Services (with requirements, coverage and status) for one function or the whole event. */
export async function listServices(db: Tx, eventId: string, opts: { functionId?: string; serviceIds?: string[]; includeRejected?: boolean } = {}): Promise<ServiceView[]> {
  const rows = await db
    .select({ service: services, typeName: serviceTypes.name, typeKey: serviceTypes.systemKey })
    .from(services)
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .where(
      and(
        eq(services.eventId, eventId),
        opts.functionId ? eq(services.functionId, opts.functionId) : undefined,
        opts.serviceIds ? inArray(services.id, opts.serviceIds.length ? opts.serviceIds : ["00000000-0000-0000-0000-000000000000"]) : undefined,
        opts.includeRejected ? undefined : ne(services.approvalState, "rejected"),
      ),
    )
    .orderBy(asc(services.sortOrder), asc(services.createdAt));
  if (rows.length === 0) return [];
  const reqs = await db
    .select()
    .from(requirements)
    .where(and(inArray(requirements.serviceId, rows.map((r) => r.service.id)), opts.includeRejected ? undefined : ne(requirements.approvalState, "rejected")))
    .orderBy(asc(requirements.sortOrder), asc(requirements.createdAt));
  const [cov, quoting, pending] = await Promise.all([coverageFor(db, eventId, reqs.map((r) => r.id)), quotingServiceIds(db, eventId), pendingEntityIds(db, eventId)]);
  return rows.map(({ service, typeName, typeKey }) => {
    const rs = reqs
      .filter((r) => r.serviceId === service.id)
      .map((r) => {
        const c = cov.get(r.id);
        return { ...r, coverage: c ?? null, status: requirementStatus(r, c, quoting.has(service.id)), pendingChange: pending.has(r.id) };
      });
    const status = service.cancelledAt ? "cancelled" : service.approvalState === "proposed" ? "proposed" : rollUp(rs.map((r) => r.status));
    return { ...service, typeName, typeKey, requirements: rs, status, pendingChange: pending.has(service.id) };
  });
}

export async function getService(db: Tx, eventId: string, serviceId: string) {
  const [s] = await listServices(db, eventId, { serviceIds: [serviceId], includeRejected: true });
  if (!s) throw new ServiceError("not_found");
  return s;
}

export type GapItem = {
  requirement: Requirement;
  serviceId: string;
  serviceName: string;
  functionId: string;
  functionName: string;
  functionDate: string | null;
  status: RequirementStatus;
  coverage: Coverage | null;
  daysLeft: number | null;
};

/** SVC-07: approved, open requirements not fully covered, by function date then must-haves first. */
export async function gapView(db: Tx, eventId: string, today: string): Promise<GapItem[]> {
  const rows = await db
    .select({ requirement: requirements, serviceId: services.id, serviceName: sql<string>`coalesce(${services.name}, ${serviceTypes.name})`, functionId: functions.id, functionName: functions.name, functionDate: functions.date })
    .from(requirements)
    .innerJoin(services, eq(services.id, requirements.serviceId))
    .innerJoin(serviceTypes, eq(serviceTypes.id, services.serviceTypeId))
    .innerJoin(functions, eq(functions.id, services.functionId))
    .where(
      and(
        eq(requirements.eventId, eventId),
        eq(requirements.approvalState, "approved"),
        eq(requirements.lifecycle, "open"),
        eq(services.approvalState, "approved"),
        isNull(services.cancelledAt),
      ),
    );
  const [cov, quoting] = await Promise.all([coverageFor(db, eventId, rows.map((r) => r.requirement.id)), quotingServiceIds(db, eventId)]);
  const day = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return rows
    .map((r) => {
      const c = cov.get(r.requirement.id) ?? null;
      return {
        ...r,
        coverage: c,
        status: requirementStatus(r.requirement, c ?? undefined, quoting.has(r.serviceId)),
        daysLeft: r.functionDate ? Math.round((day(r.functionDate) - day(today)) / 86_400_000) : null,
      };
    })
    .filter((g) => g.status !== "booked")
    .sort(
      (a, b) =>
        (a.functionDate ?? "9999").localeCompare(b.functionDate ?? "9999") ||
        (a.requirement.priority === b.requirement.priority ? 0 : a.requirement.priority === "must" ? -1 : 1) ||
        a.requirement.title.localeCompare(b.requirement.title),
    );
}

/** Default start for a requirement: its override, else the function's date and start time. */
export function requirementStart(r: Pick<Requirement, "startsAt">, fn: { date: string | null; startTime: string | null }): Date | null {
  if (r.startsAt) return r.startsAt;
  if (!fn.date) return null;
  const base = parseWallClock(`${fn.date}T${(fn.startTime ?? "00:00").slice(0, 5)}`);
  return base ? addMinutes(base, 0) : null;
}
