import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, eventMembers, events } from "@/db/schema";
import { signInWithIdentifier } from "@/lib/auth-core";
import {
  changeMemberRole,
  createEvent,
  EventError,
  eventDetailsSchema,
  inviteMember,
  listEventsForUser,
  memberCounts,
  purgeDeletedEvents,
  removeMember,
  restoreEvent,
  revokeInvitation,
  setGiftAccess,
  softDeleteEvent,
} from "@/lib/events";
import type { Identifier } from "@/lib/identifiers";
import { actorOf, db, makeUser, outbox, resetDb } from "./helpers";

beforeEach(resetDb);

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const event = await createEvent(db(), actorOf(host), { name: "Priya & Arjun", city: "Jaipur" });
  const invite = (identifier: Identifier, role: "host" | "planner" = "planner") =>
    inviteMember(db(), {
      event,
      actor: actorOf(host),
      inviterName: "Asha",
      identifier,
      role,
      locale: "en",
      appUrl: "http://localhost:3000",
    });
  return { host, event, invite };
}

describe("event details", () => {
  it("validates names and date order", () => {
    expect(eventDetailsSchema.safeParse({ name: " " }).success).toBe(false);
    const bad = eventDetailsSchema.safeParse({ name: "W", startDate: "2026-12-10", endDate: "2026-12-08" });
    expect(bad.success).toBe(false);
    expect(eventDetailsSchema.safeParse({ name: "W", startDate: "2026-12-08", endDate: "" }).success).toBe(true);
  });
});

describe("events and team", () => {
  it("makes the creator the first Host and logs it", async () => {
    const { host, event } = await setup();
    const { active } = await listEventsForUser(db(), host.id);
    expect(active.map((r) => [r.event.id, r.role])).toEqual([[event.id, "host"]]);
    const logs = await db().select().from(auditLogs).where(eq(auditLogs.eventId, event.id));
    expect(logs.map((l) => l.action)).toEqual(["event.created"]);
  });

  it("adds existing users immediately and invites new ones", async () => {
    const { event, invite } = await setup();
    const existing = await makeUser("+919876543210", "Ravi");
    expect(await invite({ type: "phone", value: "+919876543210" })).toEqual({ status: "added", userId: existing.id });
    expect((await invite({ type: "email", value: "new@example.com" }, "host")).status).toBe("invited");
    expect(await memberCounts(db(), event.id)).toEqual({ hosts: 1, planners: 1, invites: 1 });

    const msgs = await outbox();
    expect(msgs.at(-1)).toMatchObject({ channel: "email", to: "new@example.com" });
    expect(msgs.at(-1)?.body).toContain('Asha invited you to plan "Priya & Arjun" on EventHub as Host');
  });

  it("rejects duplicate invites and members", async () => {
    const { invite } = await setup();
    await invite({ type: "email", value: "new@example.com" });
    await expect(invite({ type: "email", value: "new@example.com" })).rejects.toMatchObject({ code: "already_invited" });
    await expect(invite({ type: "email", value: "host@example.com" })).rejects.toMatchObject({ code: "already_member" });
  });

  it("revoked invitations are not accepted on login", async () => {
    const { host, event, invite } = await setup();
    const res = await invite({ type: "email", value: "new@example.com" });
    if (res.status !== "invited") throw new Error();
    await revokeInvitation(db(), event.id, res.invitationId, actorOf(host));
    const { user } = await signInWithIdentifier(db(), { type: "email", value: "new@example.com" });
    expect((await listEventsForUser(db(), user.id)).active).toHaveLength(0);
  });

  it("never lets the last Host be demoted or removed", async () => {
    const { host, event, invite } = await setup();
    await expect(changeMemberRole(db(), event.id, host.id, "planner", actorOf(host))).rejects.toMatchObject({ code: "last_host" });
    await expect(removeMember(db(), event.id, host.id, actorOf(host))).rejects.toMatchObject({ code: "last_host" });

    const second = await makeUser("second@example.com", "Meera");
    await invite({ type: "email", value: "second@example.com" }, "host");
    await changeMemberRole(db(), event.id, host.id, "planner", actorOf(second));
    await expect(removeMember(db(), event.id, second.id, actorOf(second))).rejects.toBeInstanceOf(EventError);
  });

  it("concurrent demotions can't leave the event without a Host", async () => {
    const { host, event, invite } = await setup();
    const second = await makeUser("second@example.com");
    await invite({ type: "email", value: "second@example.com" }, "host");
    const results = await Promise.allSettled([
      changeMemberRole(db(), event.id, host.id, "planner", actorOf(second)),
      changeMemberRole(db(), event.id, second.id, "planner", actorOf(host)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await memberCounts(db(), event.id)).hosts).toBe(1);
  });

  it("sets Planner gift access and removes members", async () => {
    const { host, event, invite } = await setup();
    const planner = await makeUser("p@example.com", "Ravi");
    await invite({ type: "email", value: "p@example.com" });
    await setGiftAccess(db(), event.id, planner.id, "record", actorOf(host));
    const [m] = await db().select().from(eventMembers).where(and(eq(eventMembers.eventId, event.id), eq(eventMembers.userId, planner.id)));
    expect(m.giftAccess).toBe("record");
    await removeMember(db(), event.id, planner.id, actorOf(host));
    expect((await memberCounts(db(), event.id)).planners).toBe(0);
  });

  it("soft-deletes, restores within 7 days, then purges", async () => {
    const { host, event } = await setup();
    const t0 = new Date();
    await softDeleteEvent(db(), event.id, actorOf(host), t0);
    let lists = await listEventsForUser(db(), host.id);
    expect(lists.active).toHaveLength(0);
    expect(lists.deleted).toHaveLength(1);

    await restoreEvent(db(), event.id, actorOf(host), new Date(t0.getTime() + 6 * 24 * 3600_000));
    lists = await listEventsForUser(db(), host.id);
    expect(lists.active).toHaveLength(1);

    await softDeleteEvent(db(), event.id, actorOf(host), t0);
    const day8 = new Date(t0.getTime() + 8 * 24 * 3600_000);
    await expect(restoreEvent(db(), event.id, actorOf(host), day8)).rejects.toMatchObject({ code: "restore_expired" });
    expect(await purgeDeletedEvents(db(), new Date(t0.getTime() + 6 * 24 * 3600_000))).toBe(0);
    expect(await purgeDeletedEvents(db(), day8)).toBe(1);
    expect(await db().select().from(events)).toHaveLength(0);
  });
});
