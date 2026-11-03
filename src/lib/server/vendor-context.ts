import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import { events, vendors, type Event, type Vendor } from "@/db/schema";
import type { Actor } from "../audit";
import { audit } from "../audit";
import { isUuid } from "../ids";
import { decide, type Permission, type PolicySubject } from "../policy";
import { vendorLink } from "../vendor-access";
import { requireUser, type SessionContext } from "./session";

export type VendorContext = SessionContext & {
  vendor: Vendor;
  event: Event;
  actor: Actor;
  subject: PolicySubject;
  viaAdmin: boolean;
  can: (p: Permission) => boolean;
};

/**
 * Loads a vendor portal context (ADR-0023). 404 unless this login is an active contact of the
 * vendor (not revoked, vendor not archived, event not deleted). App Admins may look, audited.
 */
export const getVendorContext = cache(async (vendorId: string): Promise<VendorContext> => {
  const session = await requireUser({ allowUnnamed: true });
  if (!isUuid(vendorId)) notFound();
  const db = getDb();
  const link = await vendorLink(db, session.user.id, vendorId);
  const viaAdmin = !link && session.user.isAppAdmin;
  if (!link && !viaAdmin) notFound();
  const [row] = await db
    .select({ vendor: vendors, event: events })
    .from(vendors)
    .innerJoin(events, eq(events.id, vendors.eventId))
    .where(and(eq(vendors.id, vendorId), isNull(events.deletedAt)));
  if (!row) notFound();
  const actor: Actor = { userId: session.user.id, isAppAdmin: viaAdmin };
  const subject: PolicySubject = { isAppAdmin: viaAdmin, membership: null, vendor: { vendorId } };
  if (viaAdmin) await audit(db, { eventId: row.event.id, actor, action: "admin.vendor_portal_opened", entityType: "vendor", entityId: vendorId });
  // An App Admin looking in is read-only: never quotes, invoices or acknowledges as the vendor.
  const ADMIN_READ: ReadonlySet<Permission> = new Set(["portal.view", "portal.headcount", "portal.chat"]);
  const can = (p: Permission) => decide(subject, p) !== "deny" && (!viaAdmin || ADMIN_READ.has(p));
  return { ...session, vendor: row.vendor, event: row.event, actor, subject, viaAdmin, can };
});
