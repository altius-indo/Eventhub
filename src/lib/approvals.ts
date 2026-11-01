import { and, eq, inArray } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { approvalDecisions, approvalRequests, type ApprovalRequest } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { decide, ForbiddenError, type Permission, type PolicySubject } from "./policy";

/**
 * Generic approval engine. Feature modules register a handler per change type;
 * Planner changes become pending requests, Host/App Admin changes apply directly.
 */
export type ApplyContext = { eventId: string; actor: Actor; requestedBy: string | null };
export type ApprovalHandler<P = Record<string, unknown>> = {
  /** Permission the change needs (e.g. "budget.edit"). */
  permission: Permission;
  apply(db: Tx, payload: P, ctx: ApplyContext): Promise<void>;
};

const registry = new Map<string, ApprovalHandler>();

export function registerApprovalHandler<P extends Record<string, unknown>>(type: string, handler: ApprovalHandler<P>) {
  registry.set(type, handler as unknown as ApprovalHandler);
}

export function getApprovalHandler(type: string): ApprovalHandler {
  const handler = registry.get(type);
  if (!handler) throw new Error(`No approval handler registered for "${type}"`);
  return handler;
}

export class ApprovalError extends Error {
  constructor(public code: "not_found" | "not_pending" | "comment_required" | "not_requester") {
    super(code);
  }
}

export type SubmitInput = {
  eventId: string;
  actor: Actor;
  subject: PolicySubject;
  type: string;
  title: string;
  payload: Record<string, unknown>;
  amountPaise?: number | null;
};

export type SubmitResult = { status: "applied" } | { status: "pending"; request: ApprovalRequest };

export async function submitChange(db: Database, input: SubmitInput): Promise<SubmitResult> {
  const handler = getApprovalHandler(input.type);
  const decision = decide(input.subject, handler.permission);
  if (decision === "deny") throw new ForbiddenError(handler.permission);

  return db.transaction(async (tx) => {
    if (decision === "allow") {
      await handler.apply(tx, input.payload, { eventId: input.eventId, actor: input.actor, requestedBy: input.actor.userId });
      await audit(tx, {
        eventId: input.eventId,
        actor: input.actor,
        action: "change.applied",
        entityType: input.type,
        data: { title: input.title },
      });
      return { status: "applied" } as const;
    }
    const [request] = await tx
      .insert(approvalRequests)
      .values({
        eventId: input.eventId,
        type: input.type,
        title: input.title,
        payload: input.payload,
        amountPaise: input.amountPaise ?? null,
        requestedBy: input.actor.userId,
      })
      .returning();
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: "approval.requested",
      entityType: "approval",
      entityId: request.id,
      data: { title: input.title, type: input.type },
    });
    return { status: "pending", request } as const;
  });
}

export type DecideInput = {
  eventId: string;
  requestId: string;
  actor: Actor;
  subject: PolicySubject;
  decision: "approve" | "reject" | "request_changes";
  comment?: string | null;
};

export async function decideRequest(db: Database, input: DecideInput): Promise<ApprovalRequest> {
  if (decide(input.subject, "approvals.decide") !== "allow") throw new ForbiddenError("approvals.decide");
  const comment = input.comment?.trim() || null;
  if (input.decision !== "approve" && !comment) throw new ApprovalError("comment_required");

  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, input.requestId), eq(approvalRequests.eventId, input.eventId)))
      .for("update");
    if (!request) throw new ApprovalError("not_found");
    if (request.status !== "pending") throw new ApprovalError("not_pending");

    const now = new Date();
    await tx.insert(approvalDecisions).values({
      requestId: request.id,
      deciderId: input.actor.userId,
      decision: input.decision,
      comment,
    });

    const status = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested";
    if (input.decision === "approve") {
      await getApprovalHandler(request.type).apply(tx, request.payload, {
        eventId: request.eventId,
        actor: input.actor,
        requestedBy: request.requestedBy,
      });
    }
    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status,
        decidedAt: now,
        decidedBy: input.actor.userId,
        appliedAt: input.decision === "approve" ? now : null,
      })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    await audit(tx, {
      eventId: request.eventId,
      actor: input.actor,
      action: `approval.${status}`,
      entityType: "approval",
      entityId: request.id,
      data: { title: request.title, comment },
    });
    return updated;
  });
}

/** The requester withdraws a request that hasn't been approved. */
export async function withdrawRequest(db: Database, eventId: string, requestId: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.eventId, eventId)))
      .for("update");
    if (!request) throw new ApprovalError("not_found");
    if (request.requestedBy !== actor.userId) throw new ApprovalError("not_requester");
    if (!["pending", "changes_requested"].includes(request.status)) throw new ApprovalError("not_pending");
    await tx.update(approvalRequests).set({ status: "cancelled", decidedAt: new Date() }).where(eq(approvalRequests.id, requestId));
    await audit(tx, {
      eventId,
      actor,
      action: "approval.cancelled",
      entityType: "approval",
      entityId: requestId,
      data: { title: request.title },
    });
  });
}

/** The requester sends a revised version after a Host asked for changes or rejected it. */
export async function resubmitRequest(
  db: Database,
  input: { eventId: string; requestId: string; actor: Actor; title: string; payload: Record<string, unknown>; amountPaise?: number | null },
) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, input.requestId), eq(approvalRequests.eventId, input.eventId)))
      .for("update");
    if (!request) throw new ApprovalError("not_found");
    if (request.requestedBy !== input.actor.userId) throw new ApprovalError("not_requester");
    if (!["changes_requested", "rejected"].includes(request.status)) throw new ApprovalError("not_pending");
    const [updated] = await tx
      .update(approvalRequests)
      .set({
        status: "pending",
        title: input.title,
        payload: input.payload,
        amountPaise: input.amountPaise ?? null,
        decidedAt: null,
        decidedBy: null,
      })
      .where(eq(approvalRequests.id, request.id))
      .returning();
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: request.id,
      data: { title: input.title },
    });
    return updated;
  });
}

export async function countPendingApprovals(db: Tx, eventIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (eventIds.length === 0) return result;
  const rows = await db
    .select({ eventId: approvalRequests.eventId })
    .from(approvalRequests)
    .where(and(inArray(approvalRequests.eventId, eventIds), eq(approvalRequests.status, "pending")));
  for (const r of rows) result.set(r.eventId, (result.get(r.eventId) ?? 0) + 1);
  return result;
}
