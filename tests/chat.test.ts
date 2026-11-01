import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { eventMembers, functions, messages, notifications, threads, vendors } from "@/db/schema";
import { signInWithIdentifier } from "@/lib/auth-core";
import {
  attachmentForViewer,
  deleteOwnMessage,
  latestMessages,
  listThreadsForMember,
  markRead,
  messagesAfter,
  openThread,
  parseThreadKey,
  postMessage,
  type ChatViewer,
} from "@/lib/chat";
import { saveDocument } from "@/lib/documents";
import { createEvent } from "@/lib/events";
import { inviteVendorContact } from "@/lib/vendor-access";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const PDF = Buffer.from("%PDF-1.4\n%test file content\n");

async function setup() {
  const host = await makeUser("host@example.com", "Asha");
  const planner = await makeUser("planner@example.com", "Ravi");
  const ev = await createEvent(db(), actorOf(host), { name: "Wedding" });
  await db().insert(eventMembers).values({ eventId: ev.id, userId: planner.id, role: "planner" });
  const [fn] = await db().insert(functions).values({ eventId: ev.id, name: "Sangeet", date: "2026-12-10" }).returning();
  const [v1] = await db().insert(vendors).values({ eventId: ev.id, name: "Spice Caterers" }).returning();
  const [v2] = await db().insert(vendors).values({ eventId: ev.id, name: "Bloom Decor" }).returning();
  await inviteVendorContact(db(), { eventId: ev.id, vendorId: v1.id, identifier: { type: "email", value: "chef@spice.in" }, actor: actorOf(host), appUrl: "" });
  const { user: chef } = await db().transaction((tx) => signInWithIdentifier(tx, { type: "email", value: "chef@spice.in" }));
  const hostV: ChatViewer = { kind: "member", userId: host.id };
  const plannerV: ChatViewer = { kind: "member", userId: planner.id };
  const chefV: ChatViewer = { kind: "vendor", userId: chef.id, vendorId: v1.id };
  return { host, planner, chef, ev, fn, v1, v2, hostV, plannerV, chefV };
}

describe("chat threads and audience", () => {
  it("parses thread keys strictly", () => {
    expect(parseThreadKey("team")).toEqual({ kind: "team" });
    expect(parseThreadKey("f.not-a-uuid")).toBeNull();
    expect(parseThreadKey("x.00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("creates threads lazily and only once", async () => {
    const { ev, fn, hostV, plannerV } = await setup();
    const [a, b] = await Promise.all([openThread(db(), ev.id, { kind: "team" }, hostV), openThread(db(), ev.id, { kind: "team" }, plannerV)]);
    expect(a.id).toBe(b.id);
    const f = await openThread(db(), ev.id, { kind: "function", id: fn.id }, hostV);
    expect(f.kind).toBe("function");
    expect(await db().select().from(threads)).toHaveLength(2);
  });

  it("lets a vendor read and post only on their own vendor's thread", async () => {
    const { ev, v1, v2, fn, chefV, hostV } = await setup();
    await postMessage(db(), ev.id, { kind: "vendor", id: v1.id }, chefV, { body: "Menu attached soon" });
    const own = await openThread(db(), ev.id, { kind: "vendor", id: v1.id }, chefV);
    expect((await latestMessages(db(), own, chefV)).map((m) => m.body)).toEqual(["Menu attached soon"]);
    await expect(openThread(db(), ev.id, { kind: "vendor", id: v2.id }, chefV)).rejects.toMatchObject({ code: "not_found" });
    await expect(openThread(db(), ev.id, { kind: "team" }, chefV)).rejects.toMatchObject({ code: "not_found" });
    await expect(openThread(db(), ev.id, { kind: "function", id: fn.id }, chefV)).rejects.toMatchObject({ code: "not_found" });
    await expect(postMessage(db(), ev.id, { kind: "team" }, chefV, { body: "hi" })).rejects.toMatchObject({ code: "not_found" });
    // Staff see the vendor's message with the vendor's name.
    const msgs = await latestMessages(db(), own, hostV);
    expect(msgs[0].authorKind).toBe("vendor");
    expect(msgs[0].authorName).toContain("Spice Caterers");
  });

  it("refuses members of another event and functions/vendors from another event", async () => {
    const { ev, hostV } = await setup();
    const outsider = await makeUser("other@example.com", "Other");
    const ev2 = await createEvent(db(), actorOf(outsider), { name: "Other wedding" });
    const [fn2] = await db().insert(functions).values({ eventId: ev2.id, name: "Haldi" }).returning();
    await expect(openThread(db(), ev.id, { kind: "team" }, { kind: "member", userId: outsider.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(openThread(db(), ev.id, { kind: "function", id: fn2.id }, hostV)).rejects.toMatchObject({ code: "not_found" });
  });

  it("revoked vendor logins lose access", async () => {
    const { ev, v1, chefV } = await setup();
    await db().update(vendors).set({ archivedAt: new Date() }).where(eq(vendors.id, v1.id));
    await expect(openThread(db(), ev.id, { kind: "vendor", id: v1.id }, chefV)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("posting, mentions and notifications", () => {
  it("trims, limits length and keeps only mentions inside the audience", async () => {
    const { ev, host, planner, chef, hostV } = await setup();
    await expect(postMessage(db(), ev.id, { kind: "team" }, hostV, { body: "   " })).rejects.toMatchObject({ code: "invalid" });
    await expect(postMessage(db(), ev.id, { kind: "team" }, hostV, { body: "x".repeat(4001) })).rejects.toMatchObject({ code: "too_long" });
    const stranger = await makeUser("stranger@example.com", "Stranger");
    const { message } = await postMessage(db(), ev.id, { kind: "team" }, hostV, {
      body: "  @Ravi please check  ",
      mentions: [planner.id, chef.id, stranger.id, host.id],
    });
    expect(message.body).toBe("@Ravi please check");
    // The vendor isn't in the team thread's audience; the author can't mention themselves.
    expect(message.mentionUserIds).toEqual([planner.id]);
    const ns = await db().select().from(notifications);
    expect(ns.filter((n) => n.kind === "mention").map((n) => n.userId)).toEqual([planner.id]);
    expect(ns.some((n) => n.userId === chef.id || n.userId === stranger.id)).toBe(false);
  });

  it("vendor contacts can be mentioned on their vendor's thread and get vendor notifications", async () => {
    const { ev, v1, chef, planner, hostV } = await setup();
    await postMessage(db(), ev.id, { kind: "vendor", id: v1.id }, hostV, { body: "@chef menu?", mentions: [chef.id] });
    const ns = await db().select().from(notifications);
    const toChef = ns.find((n) => n.userId === chef.id)!;
    expect(toChef.kind).toBe("mention");
    expect(toChef.href).toBe(`/vendor/${v1.id}/messages`);
    const toPlanner = ns.find((n) => n.userId === planner.id)!;
    expect(toPlanner.kind).toBe("chat.message");
    expect(toPlanner.href).toBe(`/events/${ev.id}/messages/v.${v1.id}`);
  });

  it("doesn't pile up 'new message' notifications until the first is read", async () => {
    const { ev, planner, hostV } = await setup();
    for (let i = 0; i < 3; i++) await postMessage(db(), ev.id, { kind: "team" }, hostV, { body: `m${i}` });
    const ns = await db().select().from(notifications).where(eq(notifications.userId, planner.id));
    expect(ns).toHaveLength(1);
  });
});

describe("polling and unread counts", () => {
  it("messagesAfter returns every message exactly once, in order, even with concurrent posts", async () => {
    const { ev, hostV, plannerV } = await setup();
    const thread = await openThread(db(), ev.id, { kind: "team" }, hostV);
    let cursor = 0;
    const seen: string[] = [];
    const posts = Array.from({ length: 20 }, (_, i) => postMessage(db(), ev.id, { kind: "team" }, i % 2 ? hostV : plannerV, { body: `n${i}` }));
    // Poll while posts are in flight.
    const poll = async () => {
      const r = await messagesAfter(db(), thread, hostV, cursor);
      seen.push(...r.messages.map((m) => m.body));
      cursor = r.cursor;
    };
    // One client polls sequentially while the posts are in flight.
    let done = false;
    const poller = (async () => {
      while (!done) await poll();
    })();
    await Promise.all(posts);
    done = true;
    await poller;
    await poll();
    expect(seen.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `n${i}`).sort());
    expect(new Set(seen).size).toBe(20);
    const r = await messagesAfter(db(), thread, hostV, cursor);
    expect(r.messages).toHaveLength(0);
  });

  it("counts unread messages from others and clears them on read", async () => {
    const { ev, fn, host, planner, hostV, plannerV } = await setup();
    await postMessage(db(), ev.id, { kind: "team" }, hostV, { body: "one" });
    await postMessage(db(), ev.id, { kind: "team" }, hostV, { body: "two" });
    await postMessage(db(), ev.id, { kind: "function", id: fn.id }, plannerV, { body: "mine" });
    let list = await listThreadsForMember(db(), ev.id, planner.id);
    expect(list.find((t) => t.key === "team")!.unread).toBe(2);
    expect(list.find((t) => t.key === `f.${fn.id}`)!.unread).toBe(0);
    expect((await listThreadsForMember(db(), ev.id, host.id)).find((t) => t.key === `f.${fn.id}`)!.unread).toBe(1);
    const team = await openThread(db(), ev.id, { kind: "team" }, plannerV);
    const latest = await latestMessages(db(), team, plannerV);
    await markRead(db(), team.id, planner.id, latest[latest.length - 1].seq);
    list = await listThreadsForMember(db(), ev.id, planner.id);
    expect(list.find((t) => t.key === "team")!.unread).toBe(0);
  });

  it("lists vendors with a thread only (or quote/booking), not every vendor", async () => {
    const { ev, v1, v2, host, chefV } = await setup();
    await postMessage(db(), ev.id, { kind: "vendor", id: v1.id }, chefV, { body: "hello" });
    const keys = (await listThreadsForMember(db(), ev.id, host.id)).map((t) => t.key);
    expect(keys).toContain(`v.${v1.id}`);
    expect(keys).not.toContain(`v.${v2.id}`);
  });
});

describe("deleting and attachments", () => {
  it("only the author can delete; polling reports the deletion", async () => {
    const { ev, hostV, plannerV } = await setup();
    const { message, thread } = await postMessage(db(), ev.id, { kind: "team" }, hostV, { body: "oops" });
    await expect(deleteOwnMessage(db(), ev.id, plannerV, message.id)).rejects.toMatchObject({ code: "not_found" });
    await deleteOwnMessage(db(), ev.id, hostV, message.id);
    const [row] = await db().select().from(messages).where(eq(messages.id, message.id));
    expect(row.deletedAt).not.toBeNull();
    expect(row.body).toBe("");
    const r = await messagesAfter(db(), thread, plannerV, message.seq, message.seq);
    expect(r.deleted).toEqual([message.id]);
  });

  it("vendors can download attachments only from their own thread", async () => {
    const { ev, v1, v2, host, hostV, chefV } = await setup();
    const own = await postMessage(db(), ev.id, { kind: "vendor", id: v1.id }, hostV, { body: "", withAttachment: true });
    const other = await postMessage(db(), ev.id, { kind: "vendor", id: v2.id }, hostV, { body: "", withAttachment: true });
    const team = await postMessage(db(), ev.id, { kind: "team" }, hostV, { body: "", withAttachment: true });
    const d1 = await saveDocument(db(), ev.id, actorOf(host), { owner: { messageId: own.message.id }, kind: "other", filename: "menu.pdf", data: PDF });
    const d2 = await saveDocument(db(), ev.id, actorOf(host), { owner: { messageId: other.message.id }, kind: "other", filename: "x.pdf", data: PDF });
    const d3 = await saveDocument(db(), ev.id, actorOf(host), { owner: { messageId: team.message.id }, kind: "other", filename: "y.pdf", data: PDF });
    expect(await attachmentForViewer(db(), ev.id, chefV, d1.id)).toBe(d1.id);
    await expect(attachmentForViewer(db(), ev.id, chefV, d2.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(attachmentForViewer(db(), ev.id, chefV, d3.id)).rejects.toMatchObject({ code: "not_found" });
    const thread = await openThread(db(), ev.id, { kind: "vendor", id: v1.id }, chefV);
    expect((await latestMessages(db(), thread, chefV))[0].attachments.map((a) => a.filename)).toEqual(["menu.pdf"]);
  });
});
