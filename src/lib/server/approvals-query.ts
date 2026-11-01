import "server-only";
import { and, arrayContains, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { approvalDecisions, approvalRequests, users } from "@/db/schema";

/** The approval queue, filterable by change type and function (SVC-10). */
export async function loadApprovals(db: Tx, eventId: string, opts: { onlyRequestedBy?: string; type?: string; functionId?: string }) {
  const scope = and(
    eq(approvalRequests.eventId, eventId),
    opts.onlyRequestedBy ? eq(approvalRequests.requestedBy, opts.onlyRequestedBy) : undefined,
    opts.type ? eq(approvalRequests.type, opts.type) : undefined,
    opts.functionId ? arrayContains(approvalRequests.functionIds, [opts.functionId]) : undefined,
  );
  const rows = await db
    .select({ request: approvalRequests, requesterName: users.name })
    .from(approvalRequests)
    .leftJoin(users, eq(users.id, approvalRequests.requestedBy))
    .where(scope)
    .orderBy(desc(approvalRequests.createdAt))
    .limit(200);
  const ids = rows.map((r) => r.request.id);
  const decisions = ids.length
    ? await db
        .select({ decision: approvalDecisions, deciderName: users.name })
        .from(approvalDecisions)
        .leftJoin(users, eq(users.id, approvalDecisions.deciderId))
        .where(inArray(approvalDecisions.requestId, ids))
        .orderBy(desc(approvalDecisions.createdAt))
    : [];
  return rows.map((r) => ({
    ...r,
    lastDecision: decisions.find((d) => d.decision.requestId === r.request.id) ?? null,
  }));
}

/** Where to look at the thing a request is about. */
export async function entityLinks(db: Tx, eventId: string, rows: { entityType: string | null; entityId: string | null }[]) {
  const { requirements, payments } = await import("@/db/schema");
  const reqIds = rows.filter((r) => r.entityType === "requirement" && r.entityId).map((r) => r.entityId!);
  const payIds = rows.filter((r) => r.entityType === "payment" && r.entityId).map((r) => r.entityId!);
  const reqs = reqIds.length ? await db.select({ id: requirements.id, serviceId: requirements.serviceId }).from(requirements).where(inArray(requirements.id, reqIds)) : [];
  const pays = payIds.length ? await db.select({ id: payments.id, bookingId: payments.bookingId }).from(payments).where(inArray(payments.id, payIds)) : [];
  const base = `/events/${eventId}`;
  return (r: { entityType: string | null; entityId: string | null }): string | null => {
    if (!r.entityId) return null;
    switch (r.entityType) {
      case "service":
        return `${base}/services/${r.entityId}`;
      case "requirement": {
        const q = reqs.find((x) => x.id === r.entityId);
        return q ? `${base}/services/${q.serviceId}` : null;
      }
      case "booking":
        return `${base}/vendors/bookings/${r.entityId}`;
      case "budget_line":
        return `${base}/budget/lines`;
      case "payment": {
        const p = pays.find((x) => x.id === r.entityId);
        return p?.bookingId ? `${base}/vendors/bookings/${p.bookingId}` : `${base}/budget/lines`;
      }
      default:
        return null;
    }
  };
}
