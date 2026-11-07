import { describe, expect, it } from "vitest";
import { decide, permissions, type PolicySubject } from "@/lib/policy";

const host: PolicySubject = { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } };
const planner: PolicySubject = { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } };
const admin: PolicySubject = { isAppAdmin: true, membership: null };
const outsider: PolicySubject = { isAppAdmin: false, membership: null };

describe("policy", () => {
  it("App Admin can do everything, including platform settings", () => {
    for (const p of permissions) expect(decide(admin, p)).toBe("allow");
  });

  it("Hosts can do everything in their event but not platform settings or the vendor portal", () => {
    for (const p of permissions) expect(decide(host, p)).toBe(p === "platform.manage" || p.startsWith("portal.") ? "deny" : "allow");
  });

  it("vendor logins get the portal and nothing else (ADR-0023)", () => {
    const vendor = { isAppAdmin: false, membership: null, vendor: { vendorId: "v1" } };
    for (const p of permissions) expect(decide(vendor, p)).toBe(p.startsWith("portal.") ? "allow" : "deny");
  });

  it("Hosts and Planners view and edit the gift list, whatever the old gift-access grant (GFT-07)", () => {
    for (const giftAccess of ["none", "record", "full"] as const) {
      const p = { isAppAdmin: false, membership: { role: "planner" as const, giftAccess } };
      expect(decide(p, "gifts.view")).toBe("allow");
      expect(decide(p, "gifts.manage")).toBe("allow");
    }
    expect(decide(host, "gifts.manage")).toBe("allow");
    expect(decide(outsider, "gifts.view")).toBe("deny");
    expect(decide({ isAppAdmin: false, membership: null, vendor: { vendorId: "v1" } }, "gifts.view")).toBe("deny");
  });

  it("non-members can do nothing", () => {
    for (const p of permissions) expect(decide(outsider, p)).toBe("deny");
  });

  it("Planner changes to services and money need Host approval", () => {
    for (const p of ["services.edit", "bookings.create", "budget.edit", "payments.record"] as const) {
      expect(decide(planner, p)).toBe("approval");
    }
  });

  it("Planners edit day-to-day planning directly", () => {
    for (const p of ["guests.edit", "rsvp.edit", "itinerary.edit", "runsheet.edit", "messaging.send", "website.edit"] as const) {
      expect(decide(planner, p)).toBe("allow");
    }
  });

  it("Planners can't manage the team, settings, approvals or publishing", () => {
    for (const p of ["event.update", "event.delete", "members.manage", "approvals.decide", "website.publish", "audit.view", "platform.manage"] as const) {
      expect(decide(planner, p)).toBe("deny");
    }
  });

  it("Hosts and Planners view, upload and moderate the gallery; vendors only through the portal (GAL-02/04)", () => {
    for (const p of ["gallery.view", "gallery.upload", "gallery.moderate"] as const) {
      expect(decide(host, p)).toBe("allow");
      expect(decide(planner, p)).toBe("allow");
      expect(decide({ isAppAdmin: false, membership: null, vendor: { vendorId: "v1" } }, p)).toBe("deny");
      expect(decide(outsider, p)).toBe("deny");
    }
    expect(decide({ isAppAdmin: false, membership: null, vendor: { vendorId: "v1" } }, "portal.gallery")).toBe("allow");
    expect(decide(planner, "portal.gallery")).toBe("deny");
  });

  it("only Hosts and App Admins can download the full archive (EVT-08)", () => {
    expect(decide(host, "event.export")).toBe("allow");
    expect(decide(admin, "event.export")).toBe("allow");
    expect(decide(planner, "event.export")).toBe("deny");
    const fullGifts = { ...planner, membership: { role: "planner" as const, giftAccess: "full" as const } };
    expect(decide(fullGifts, "event.export")).toBe("deny");
    expect(decide({ isAppAdmin: false, membership: null, vendor: { vendorId: "v1" } }, "event.export")).toBe("deny");
  });
});
