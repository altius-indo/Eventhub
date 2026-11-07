import type { GiftAccess, MemberRole } from "@/db/schema";

/**
 * Permissions from the requirements' permission matrix (§2.1).
 * "approval" means the action is allowed but must go through a Host's approval.
 */
export const permissions = [
  // Event & team
  "event.view",
  "event.update",
  "event.delete",
  // Full archive download (EVT-08): Hosts and App Admins only
  "event.export",
  "members.view",
  "members.manage",
  "audit.view",
  "approvals.view",
  "approvals.decide",
  "limits.request",
  // Planning modules (built in later milestones)
  "guests.edit",
  "rsvp.edit",
  "travel.edit",
  "seating.edit",
  "checkin.operate",
  "itinerary.edit",
  "runsheet.edit",
  "tasks.edit",
  "services.edit",
  "services.catalogue",
  "vendors.edit",
  "vendors.bank_view",
  "bookings.create",
  "contracts.edit",
  "budget.edit",
  "budget.thresholds",
  "invoices.edit",
  "payments.record",
  "messaging.send",
  "chat.post",
  "limits.view",
  "headcount.lock",
  "gifts.manage",
  // Vendor portal (VND-10): only for a vendor login, never for members
  "portal.view",
  "portal.quote",
  "portal.invoice",
  "portal.chat",
  "portal.headcount",
  // Gallery deliveries (GAL-02/07): photographers/videographers booked for a function
  "portal.gallery",
  "reports.view",
  "gifts.view",
  "website.edit",
  "website.publish",
  "gallery.view",
  "gallery.upload",
  "gallery.moderate",
  // Platform
  "platform.manage",
] as const;

export type Permission = (typeof permissions)[number];
export type Decision = "allow" | "approval" | "deny";

export type PolicySubject = {
  isAppAdmin: boolean;
  membership: { role: MemberRole; giftAccess: GiftAccess } | null;
  /** A vendor's portal login (ADR-0023). Vendors are never event members. */
  vendor?: { vendorId: string } | null;
};

const PLATFORM_ONLY: ReadonlySet<Permission> = new Set(["platform.manage"]);
const PORTAL: ReadonlySet<Permission> = new Set(["portal.view", "portal.quote", "portal.invoice", "portal.chat", "portal.headcount", "portal.gallery"]);

const PLANNER: Partial<Record<Permission, Decision>> = {
  "event.view": "allow",
  "members.view": "allow",
  "approvals.view": "allow",
  "guests.edit": "allow",
  "rsvp.edit": "allow",
  "travel.edit": "allow",
  "seating.edit": "allow",
  "checkin.operate": "allow",
  "itinerary.edit": "allow",
  "runsheet.edit": "allow",
  "tasks.edit": "allow",
  "vendors.edit": "allow",
  "vendors.bank_view": "allow",
  "services.catalogue": "allow",
  "invoices.edit": "allow",
  "contracts.edit": "allow",
  "messaging.send": "allow",
  "chat.post": "allow",
  "limits.view": "allow",
  "headcount.lock": "allow",
  "reports.view": "allow",
  // Gifts to give and thank-you notes (GFT-07)
  "gifts.view": "allow",
  "gifts.manage": "allow",
  "website.edit": "allow",
  "gallery.view": "allow",
  "gallery.upload": "allow",
  "gallery.moderate": "allow",
  // Changes Hosts must approve (SVC-10, BGT-04)
  "services.edit": "approval",
  "bookings.create": "approval",
  "budget.edit": "approval",
  "payments.record": "approval",
};

export function decide(subject: PolicySubject, permission: Permission): Decision {
  if (subject.isAppAdmin) return "allow";
  if (PLATFORM_ONLY.has(permission)) return "deny";
  const m = subject.membership;
  // Portal permissions belong to vendor logins only; staff use the staff pages.
  if (PORTAL.has(permission)) return !m && subject.vendor ? "allow" : "deny";
  if (!m) return "deny";
  if (m.role === "host") return "allow";
  return PLANNER[permission] ?? "deny";
}

export function can(subject: PolicySubject, permission: Permission): boolean {
  return decide(subject, permission) !== "deny";
}

export class ForbiddenError extends Error {
  constructor(public permission?: Permission) {
    super(permission ? `Not allowed: ${permission}` : "Not allowed");
  }
}

export function assertCan(subject: PolicySubject, permission: Permission): void {
  if (!can(subject, permission)) throw new ForbiddenError(permission);
}
