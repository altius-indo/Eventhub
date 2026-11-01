import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { devOutbox, eventMembers, eventLimitOverrides, messageUsage, notifications, outboundMessages, vendorContacts } from "@/db/schema";
import "@/lib/approval-handlers";
import { decideRequest } from "@/lib/approvals";
import { signInWithIdentifier } from "@/lib/auth-core";
import { DeliveryError } from "@/lib/delivery";
import { createEvent } from "@/lib/events";
import { getPrefs, listNotifications, markRead, notify, setPrefs, unreadCount } from "@/lib/notifications";
import { enqueue, estimate, getUsage, optOut, processOutbox, QuotaError, registerTemplate, type EnqueueItem } from "@/lib/outbox";
import { addBudgetLine } from "@/lib/budget";
import { listServiceTypes } from "@/lib/catalogue";
import { createVendor } from "@/lib/vendors";
import { inviteVendorContact, vendorLinksForUser, revokeVendorContact } from "@/lib/vendor-access";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

let failures = 0;
registerTemplate("test.flaky", () => {
  if (failures > 0) {
    failures--;
    throw new DeliveryError("provider down");
  }
  return { subject: "Hi", text: "Hello" };
});

async function event() {
  const host = await makeUser("host@example.com", "Asha");
  const ev = await createEvent(db(), actorOf(host), { name: "Wedding" });
  return { host, ev };
}

const msg = (eventId: string, i: number, over: Partial<EnqueueItem> = {}): EnqueueItem => ({
  eventId,
  purpose: "broadcast",
  templateKey: "plain",
  vars: { subject: "Hello", text: `Message ${i}` },
  recipient: { addresses: { email: `guest${i}@example.com` } },
  channels: ["email"],
  bulk: true,
  key: `t:${eventId}:${i}`,
  ...over,
});

describe("outbox", () => {
  it("queues, sends once even with concurrent drains, and counts usage", async () => {
    const { ev } = await event();
    const r = await db().transaction((tx) => enqueue(tx, [msg(ev.id, 1), msg(ev.id, 2), msg(ev.id, 2)]));
    expect(r.queued).toBe(2);
    let u = await getUsage(db(), ev.id);
    expect(u.email.reserved).toBe(2);
    await Promise.all([processOutbox(db()), processOutbox(db())]);
    const sent = await db().select().from(devOutbox);
    expect(sent.filter((m) => m.body.startsWith("Message"))).toHaveLength(2);
    u = await getUsage(db(), ev.id);
    expect([u.email.used, u.email.reserved]).toEqual([2, 0]);
  });

  it("refuses a bulk send over the limit as a whole, but one-to-one messages still go", async () => {
    const { ev } = await event();
    await db().insert(eventLimitOverrides).values({ eventId: ev.id, channel: "email", limit: 2 });
    const est = await estimate(db(), ev.id, [msg(ev.id, 1), msg(ev.id, 2), msg(ev.id, 3)]);
    expect(est.overLimit).toEqual(["email"]);
    await expect(db().transaction((tx) => enqueue(tx, [msg(ev.id, 1), msg(ev.id, 2), msg(ev.id, 3)]))).rejects.toBeInstanceOf(QuotaError);
    expect(await db().select().from(outboundMessages)).toHaveLength(0);
    await db().transaction((tx) => enqueue(tx, [msg(ev.id, 1), msg(ev.id, 2)]));
    await processOutbox(db());
    const single = await db().transaction((tx) => enqueue(tx, [msg(ev.id, 9, { bulk: false, purpose: "guest_link" })]));
    expect(single.queued).toBe(1);
  });

  it("warns Hosts once at 80% and once at 95%", async () => {
    const { ev, host } = await event();
    await db().insert(eventLimitOverrides).values({ eventId: ev.id, channel: "email", limit: 10 });
    for (let i = 0; i < 10; i++) await db().transaction((tx) => enqueue(tx, [msg(ev.id, i, { bulk: false })]));
    await processOutbox(db());
    const warnings = (await db().select().from(notifications).where(eq(notifications.userId, host.id))).filter((n) => n.kind === "usage.warning");
    expect(warnings.map((w) => w.data.pct).sort()).toEqual([80, 95]);
    const [row] = await db().select().from(messageUsage).where(eq(messageUsage.eventId, ev.id));
    // The two warning emails to the Host count against the event's email limit too.
    expect(row.used).toBe(12);
  });

  it("skips opted-out addresses for broadcasts, honouring opt-outs made after queueing", async () => {
    const { ev } = await event();
    await db().transaction((tx) => enqueue(tx, [msg(ev.id, 1), msg(ev.id, 2)]));
    await optOut(db(), ev.id, "email", "GUEST2@example.com", "unsubscribe_link");
    await processOutbox(db());
    const rows = await db().select().from(outboundMessages);
    expect(rows.map((r) => r.status).sort()).toEqual(["sent", "skipped_optout"]);
    const e = await estimate(db(), ev.id, [msg(ev.id, 2)]);
    expect(e.skipped.opted_out).toBe(1);
  });

  it("retries with backoff, then falls back to the next channel", async () => {
    const { ev } = await event();
    failures = 4;
    await db().transaction((tx) =>
      enqueue(tx, [
        {
          eventId: ev.id,
          purpose: "guest_link",
          templateKey: "test.flaky",
          vars: {},
          recipient: { addresses: { whatsapp: "+919876543210", email: "fam@example.com" } },
          bulk: false,
          key: "flaky:1",
        },
      ]),
    );
    let t = Date.now();
    for (let i = 0; i < 4; i++) {
      await processOutbox(db(), { now: () => new Date(t) });
      t += 3 * 3600_000;
    }
    await processOutbox(db(), { now: () => new Date(t) });
    const rows = await db().select().from(outboundMessages).orderBy(outboundMessages.createdAt);
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ["whatsapp", "failed"],
      ["email", "sent"],
    ]);
  });
});

describe("notifications", () => {
  it("tells the Planner about a Host's decision, in-app and by email by default", async () => {
    const { ev, host } = await event();
    const planner = await makeUser("planner@example.com", "Ravi");
    await db().insert(eventMembers).values({ eventId: ev.id, userId: planner.id, role: "planner" });
    const gifts = (await listServiceTypes(db(), ev.id)).find((t) => t.systemKey === "gifts")!;
    const r = await addBudgetLine(db(), { eventId: ev.id, actor: actorOf(planner), subject: { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } } }, {
      categoryId: gifts.id,
      functionId: null,
      title: "Return gifts",
      estimatePaise: 100,
      payer: null,
      notes: null,
    });
    if (r.status !== "pending") throw new Error();
    expect((await listNotifications(db(), host.id)).map((n) => n.n.kind)).toContain("approval.requested");
    await decideRequest(db(), { eventId: ev.id, requestId: r.request.id, actor: actorOf(host), subject: { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } }, decision: "reject", comment: "Too much" });
    const mine = await listNotifications(db(), planner.id);
    expect(mine[0].n.kind).toBe("approval.rejected");
    expect(mine[0].n.data.comment).toBe("Too much");
    expect(await unreadCount(db(), planner.id)).toBe(1);
    await markRead(db(), planner.id, "all");
    expect(await unreadCount(db(), planner.id)).toBe(0);
    const queued = await db().select().from(outboundMessages).where(eq(outboundMessages.userId, planner.id));
    expect(queued).toHaveLength(1);
  });

  it("respects email preferences", async () => {
    const { ev, host } = await event();
    await setPrefs(db(), host.id, { mentions: false });
    expect((await getPrefs(db(), host.id)).mentions).toBe(false);
    await notify(db(), { userIds: [host.id], eventId: ev.id, kind: "mention", data: { author: "Ravi", thread: "Team", snippet: "hi" } });
    expect(await db().select().from(outboundMessages)).toHaveLength(0);
    expect(await unreadCount(db(), host.id)).toBe(1);
  });
});

describe("vendor access (ADR-0023)", () => {
  it("invites by email, links on first login, works across two events, and can be revoked", async () => {
    const { ev, host } = await event();
    const ev2 = await createEvent(db(), actorOf(host), { name: "Second" });
    const v1 = await createVendor(db(), ev.id, actorOf(host), { name: "Spice", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    const v2 = await createVendor(db(), ev2.id, actorOf(host), { name: "Spice", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    await inviteVendorContact(db(), { eventId: ev.id, vendorId: v1.id, identifier: { type: "email", value: "chef@spice.in" }, actor: actorOf(host), appUrl: "" });
    await inviteVendorContact(db(), { eventId: ev2.id, vendorId: v2.id, identifier: { type: "email", value: "chef@spice.in" }, actor: actorOf(host), appUrl: "" });
    await expect(inviteVendorContact(db(), { eventId: ev.id, vendorId: v1.id, identifier: { type: "email", value: "chef@spice.in" }, actor: actorOf(host), appUrl: "" })).rejects.toMatchObject({ code: "duplicate" });
    const { user } = await db().transaction((tx) => signInWithIdentifier(tx, { type: "email", value: "chef@spice.in" }));
    const links = await vendorLinksForUser(db(), user.id);
    expect(links.map((l) => l.eventId).sort()).toEqual([ev.id, ev2.id].sort());
    const [c] = await db().select().from(vendorContacts).where(eq(vendorContacts.vendorId, v1.id));
    await revokeVendorContact(db(), ev.id, c.id, actorOf(host));
    expect((await vendorLinksForUser(db(), user.id)).map((l) => l.eventId)).toEqual([ev2.id]);
  });

  it("won't make an event's own member its vendor", async () => {
    const { ev, host } = await event();
    const v = await createVendor(db(), ev.id, actorOf(host), { name: "Cousin Decor", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    await expect(inviteVendorContact(db(), { eventId: ev.id, vendorId: v.id, identifier: { type: "email", value: "host@example.com" }, actor: actorOf(host), appUrl: "" })).rejects.toMatchObject({ code: "is_member" });
  });
});
