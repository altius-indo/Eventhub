import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvalDecisions, auditLogs, events } from "@/db/schema";
import { decideRequest, registerApprovalHandler, resubmitRequest, submitChange, withdrawRequest } from "@/lib/approvals";
import { createEvent, inviteMember } from "@/lib/events";
import { ForbiddenError, type PolicySubject } from "@/lib/policy";
import { actorOf, db, makeUser, resetDb } from "./helpers";

// A stand-in for a real module's change type: renames the event's city.
beforeAll(() => {
  registerApprovalHandler<{ city: string }>("test.set_city", {
    permission: "budget.edit",
    async apply(tx, payload, ctx) {
      await tx.update(events).set({ city: payload.city }).where(eq(events.id, ctx.eventId));
    },
  });
});
beforeEach(resetDb);

const hostSubject: PolicySubject = { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } };
const plannerSubject: PolicySubject = { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } };

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const planner = await makeUser("planner@example.com", "Ravi");
  const event = await createEvent(db(), actorOf(host), { name: "Wedding", city: "Jaipur" });
  await inviteMember(db(), {
    event,
    actor: actorOf(host),
    inviterName: "Asha",
    identifier: { type: "email", value: "planner@example.com" },
    role: "planner",
    locale: "en",
    appUrl: "x",
  });
  const city = async () => (await db().select().from(events).where(eq(events.id, event.id)))[0].city;
  const submit = (who: typeof host, subject: PolicySubject, newCity: string) =>
    submitChange(db(), {
      eventId: event.id,
      actor: actorOf(who),
      subject,
      type: "test.set_city",
      title: `Move to ${newCity}`,
      payload: { city: newCity },
      amountPaise: 5000000,
    });
  return { host, planner, event, city, submit };
}

describe("approval engine", () => {
  it("applies Host changes immediately", async () => {
    const { host, city, submit } = await setup();
    expect(await submit(host, hostSubject, "Udaipur")).toEqual({ status: "applied" });
    expect(await city()).toBe("Udaipur");
  });

  it("queues Planner changes until a Host approves", async () => {
    const { host, planner, event, city, submit } = await setup();
    const res = await submit(planner, plannerSubject, "Udaipur");
    if (res.status !== "pending") throw new Error("expected pending");
    expect(await city()).toBe("Jaipur");

    await expect(
      decideRequest(db(), { eventId: event.id, requestId: res.request.id, actor: actorOf(planner), subject: plannerSubject, decision: "approve" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const approved = await decideRequest(db(), {
      eventId: event.id,
      requestId: res.request.id,
      actor: actorOf(host),
      subject: hostSubject,
      decision: "approve",
    });
    expect(approved.status).toBe("approved");
    expect(await city()).toBe("Udaipur");

    await expect(
      decideRequest(db(), { eventId: event.id, requestId: res.request.id, actor: actorOf(host), subject: hostSubject, decision: "approve" }),
    ).rejects.toMatchObject({ code: "not_pending" });

    const actions = (await db().select().from(auditLogs).where(eq(auditLogs.eventId, event.id))).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["approval.requested", "approval.approved"]));
  });

  it("requires a comment to reject or request changes, and supports resubmitting", async () => {
    const { host, planner, event, city, submit } = await setup();
    const res = await submit(planner, plannerSubject, "Goa");
    if (res.status !== "pending") throw new Error();
    const base = { eventId: event.id, requestId: res.request.id, actor: actorOf(host), subject: hostSubject };
    await expect(decideRequest(db(), { ...base, decision: "reject", comment: "  " })).rejects.toMatchObject({ code: "comment_required" });

    const changes = await decideRequest(db(), { ...base, decision: "request_changes", comment: "Too far for elders" });
    expect(changes.status).toBe("changes_requested");
    expect(await db().select().from(approvalDecisions)).toHaveLength(1);

    await expect(
      resubmitRequest(db(), { eventId: event.id, requestId: res.request.id, actor: actorOf(host), title: "x", payload: { city: "x" } }),
    ).rejects.toMatchObject({ code: "not_requester" });
    const again = await resubmitRequest(db(), {
      eventId: event.id,
      requestId: res.request.id,
      actor: actorOf(planner),
      title: "Move to Jodhpur",
      payload: { city: "Jodhpur" },
    });
    expect(again.status).toBe("pending");
    await decideRequest(db(), { ...base, decision: "approve" });
    expect(await city()).toBe("Jodhpur");
  });

  it("lets the requester withdraw a pending request", async () => {
    const { planner, event, city, submit } = await setup();
    const res = await submit(planner, plannerSubject, "Goa");
    if (res.status !== "pending") throw new Error();
    await withdrawRequest(db(), event.id, res.request.id, actorOf(planner));
    expect(await city()).toBe("Jaipur");
    await expect(withdrawRequest(db(), event.id, res.request.id, actorOf(planner))).rejects.toMatchObject({ code: "not_pending" });
  });

  it("refuses changes from people outside the event", async () => {
    const { submit } = await setup();
    const stranger = await makeUser("x@example.com");
    await expect(submit(stranger, { isAppAdmin: false, membership: null }, "Goa")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
