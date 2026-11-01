import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { approvalDecisions, approvalRequests, users } from "@/db/schema";

export async function loadApprovals(db: Tx, eventId: string, opts: { onlyRequestedBy?: string }) {
  const scope = opts.onlyRequestedBy
    ? and(eq(approvalRequests.eventId, eventId), eq(approvalRequests.requestedBy, opts.onlyRequestedBy))
    : eq(approvalRequests.eventId, eventId);
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
