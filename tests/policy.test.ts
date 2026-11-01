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

  it("gift management needs full gift access for Planners", () => {
    const access = (giftAccess: "none" | "record" | "full") => ({ isAppAdmin: false, membership: { role: "planner" as const, giftAccess } });
    expect(decide(access("none"), "gifts.record")).toBe("deny");
    expect(decide(access("record"), "gifts.record")).toBe("allow");
    expect(decide(access("record"), "gifts.manage")).toBe("deny");
    expect(decide(access("full"), "gifts.manage")).toBe("allow");
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

  it("gift access for Planners follows what the Host granted", () => {
    expect(decide(planner, "gifts.view")).toBe("deny");
    expect(decide(planner, "gifts.record")).toBe("deny");
    const recorder = { ...planner, membership: { role: "planner" as const, giftAccess: "record" as const } };
    expect(decide(recorder, "gifts.record")).toBe("allow");
    expect(decide(recorder, "gifts.view")).toBe("deny");
    const full = { ...planner, membership: { role: "planner" as const, giftAccess: "full" as const } };
    expect(decide(full, "gifts.view")).toBe("allow");
  });
});
