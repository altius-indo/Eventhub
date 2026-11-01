import type { Tx } from "@/db";
import { auditLogs } from "@/db/schema";

export type Actor = { userId: string; isAppAdmin: boolean };

export type AuditEntry = {
  eventId?: string | null;
  actor: Actor | null;
  action: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  ip?: string | null;
};

export async function audit(db: Tx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    eventId: entry.eventId ?? null,
    actorUserId: entry.actor?.userId ?? null,
    actorIsAppAdmin: entry.actor?.isAppAdmin ?? false,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    data: entry.data,
    ip: entry.ip ?? null,
  });
}
