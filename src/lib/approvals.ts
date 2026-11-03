import { and, eq, inArray } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { approvalDecisions, approvalRequests, type ApprovalRequest } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { notify, notifyHosts } from "./notifications";
import { decide, ForbiddenError, type Permission, type PolicySubject } from "./policy";

/**
 * Generic approval engine. Feature modules register a handler per change type;
 * Planner changes become pending requests, Host/App Admin changes apply directly.
 */
export type ApplyContext = { eventId: string; actor: Actor; requestedBy: string | null };
export type ApprovalHandler<P = Record<string, unknown>> = {
  /** Permission the change needs (e.g. "budget.edit"). */
  permission: Permission;
  /** Applies the change. Throw ApprovalError("stale") if what was proposed no longer matches. */
  apply(db: Tx, payload: P, ctx: ApplyContext): Promise<void>;
  /**
   * Called when a request is rejected or withdrawn, to discard what was staged
   * (e.g. mark a proposed row rejected, cancel a pending booking).
   */
  onClosed?(db: Tx, payload: P, ctx: ApplyContext, outcome: "rejected" | "cancelled"): Promise<void>;
  /**
   * Whether a Planner's change may apply without a Host: per-category thresholds and no
   * overspend (BGT-04, ADR-0017). Absent = always needs a Host.
   */
  autoApprove?(db: Tx, payload: P, eventId: string): Promise<boolean>;
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
  constructor(public code: "not_found" | "not_pending" | "comment_required" | "not_requester" | "stale") {
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
  /** The row the change is about, and the functions it touches (queue filters, SVC-10). */
  entityType?: string;
  entityId?: string;
  functionIds?: string[];
};

export type SubmitResult = { status: "applied"; auto?: boolean } | { status: "pending"; request: ApprovalRequest };

export async function submitChange(db: Database, input: SubmitInput): Promise<SubmitResult> {
  return db.transaction((tx) => submitChangeTx(tx, input));
}

/** As submitChange, inside the caller's transaction (so staging a row and submitting are atomic). */
export async function submitChangeTx(tx: Tx, input: SubmitInput): Promise<SubmitResult> {
  const handler = getApprovalHandler(input.type);
  const decision = decide(input.subject, handler.permission);
  if (decision === "deny") throw new ForbiddenError(handler.permission);
  const ctx = { eventId: input.eventId, actor: input.actor, requestedBy: input.actor.userId };

  {
    const auto = decision === "approval" && handler.autoApprove ? await handler.autoApprove(tx, input.payload, input.eventId) : false;
    if (decision === "allow" || auto) {
      await handler.apply(tx, input.payload, ctx);
      await audit(tx, {
        eventId: input.eventId,
        actor: input.actor,
        action: auto ? "change.auto_approved" : "change.applied",
        entityType: input.type,
        entityId: input.entityId,
        data: { title: input.title, amount: input.amountPaise ?? null },
      });
      return auto ? ({ status: "applied", auto: true } as const) : ({ status: "applied" } as const);
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
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        functionIds: input.functionIds ?? [],
      })
      .returning();
    // Hosts see it in their notification centre; the daily reminder emails them (BGT-04).
    await notifyHosts(tx, input.eventId, {
      kind: "approval.requested",
      data: { title: input.title, type: input.type },
      href: `/events/${input.eventId}/approvals`,
      exceptUserId: input.actor.userId,
      noEmail: true,
    });
    await audit(tx, {
      eventId: input.eventId,
      actor: input.actor,
      action: "approval.requested",
      entityType: "approval",
      entityId: request.id,
      data: { title: input.title, type: input.type },
    });
    return { status: "pending", request } as const;
  }
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
    const handler = getApprovalHandler(request.type);
    const ctx = { eventId: request.eventId, actor: input.actor, requestedBy: request.requestedBy };
    if (input.decision === "approve") await handler.apply(tx, request.payload, ctx);
    if (input.decision === "reject") await handler.onClosed?.(tx, request.payload, ctx, "rejected");
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
    // SVC-10: the Planner hears about the decision (in-app, and email unless turned off).
    if (request.requestedBy) {
      await notify(tx, {
        userIds: [request.requestedBy],
        eventId: request.eventId,
        kind: `approval.${status}`,
        data: { title: request.title, type: request.type, comment },
        href: `/events/${request.eventId}/approvals`,
        exceptUserId: input.actor.userId,
      });
    }
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
    await getApprovalHandler(request.type).onClosed?.(tx, request.payload, { eventId, actor, requestedBy: request.requestedBy }, "cancelled");
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

/** The requester sends a revised version after a Host asked for changes. */
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
    // A rejected request's staged rows are discarded, so only "changes requested" can be resubmitted.
    if (request.status !== "changes_requested") throw new ApprovalError("not_pending");
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

/**
 * Keeps an open request in step with its staged row (ADR-0016): when a proposed row is edited,
 * the request gets the new version, amount and title and goes back to "pending", so a Host
 * always approves exactly what the queue shows. Approving checks the version.
 */
export async function refreshOpenRequest(
  tx: Tx,
  input: { eventId: string; entityType: string; entityId: string; actor: Actor; payload: Record<string, unknown>; amountPaise?: number | null; title?: string },
) {
  const [request] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.eventId, input.eventId),
        eq(approvalRequests.entityType, input.entityType),
        eq(approvalRequests.entityId, input.entityId),
        inArray(approvalRequests.status, ["pending", "changes_requested"]),
      ),
    )
    .for("update");
  if (!request) return null;
  const [updated] = await tx
    .update(approvalRequests)
    .set({
      payload: input.payload,
      ...(input.amountPaise !== undefined ? { amountPaise: input.amountPaise } : {}),
      ...(input.title ? { title: input.title } : {}),
      status: "pending",
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
    data: { title: input.title ?? request.title },
  });
  return updated;
}

/** Result of editing a staged row: "pending" when its request was (re)sent to a Host. */
export const stagedResult = (request: ApprovalRequest | null): SubmitResult => (request ? { status: "pending", request } : { status: "applied" });
