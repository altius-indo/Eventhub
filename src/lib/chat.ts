import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import {
  bookings,
  documents,
  eventMembers,
  events,
  functions,
  messages,
  notifications,
  quoteRequests,
  threadReads,
  threads,
  users,
  vendors,
  type Thread,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { isUuid } from "./ids";
import { notify } from "./notifications";
import { vendorLink, vendorUserIds } from "./vendor-access";

/**
 * In-app chat (MSG-01): one team thread per event, one per function and one per vendor, created
 * lazily on first open. Clients poll `messagesAfter` with a per-thread cursor (ADR-0026).
 *
 * Audience: every event member (and App Admins, audited by the event context) sees every thread.
 * A vendor's portal logins see only their own vendor's thread.
 */

export const MAX_MESSAGE_CHARS = 4000;
const PAGE = 100;

export class ChatError extends Error {
  constructor(public code: "not_found" | "invalid" | "too_long" | "forbidden") {
    super(code);
  }
}

/** Who is reading or writing. Members are checked against event_members unless App Admin. */
export type ChatViewer =
  | { kind: "member"; userId: string; isAppAdmin?: boolean }
  | { kind: "vendor"; userId: string; vendorId: string; isAppAdmin?: boolean };

/** Thread keys used in URLs: "team", "f.<functionId>", "v.<vendorId>". */
export type ThreadKey = { kind: "team" } | { kind: "function"; id: string } | { kind: "vendor"; id: string };

export function parseThreadKey(raw: string): ThreadKey | null {
  if (raw === "team") return { kind: "team" };
  const m = /^([fv])\.(.+)$/.exec(raw);
  if (!m || !isUuid(m[2])) return null;
  return m[1] === "f" ? { kind: "function", id: m[2] } : { kind: "vendor", id: m[2] };
}

export function threadKeyOf(t: Pick<Thread, "kind" | "functionId" | "vendorId">): string {
  if (t.kind === "function") return `f.${t.functionId}`;
  if (t.kind === "vendor") return `v.${t.vendorId}`;
  return "team";
}

export function actorOfViewer(v: ChatViewer): Actor {
  return { userId: v.userId, isAppAdmin: !!v.isAppAdmin };
}

async function assertViewer(db: Tx, eventId: string, viewer: ChatViewer) {
  if (viewer.kind === "member") {
    if (viewer.isAppAdmin) return;
    const [m] = await db
      .select({ id: eventMembers.id })
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, viewer.userId)));
    if (!m) throw new ChatError("not_found");
    return;
  }
  if (viewer.isAppAdmin) return;
  const link = await vendorLink(db, viewer.userId, viewer.vendorId);
  if (!link || link.eventId !== eventId) throw new ChatError("not_found");
}

/**
 * Finds or creates the thread for a key, checking the function/vendor belongs to the event
 * and that the viewer may see it. Vendors may only open their own vendor's thread.
 */
export async function openThread(db: Tx, eventId: string, key: ThreadKey, viewer: ChatViewer): Promise<Thread> {
  await assertViewer(db, eventId, viewer);
  if (viewer.kind === "vendor" && (key.kind !== "vendor" || key.id !== viewer.vendorId)) throw new ChatError("not_found");
  const where =
    key.kind === "team"
      ? and(eq(threads.eventId, eventId), eq(threads.kind, "team"))
      : key.kind === "function"
        ? and(eq(threads.eventId, eventId), eq(threads.kind, "function"), eq(threads.functionId, key.id))
        : and(eq(threads.eventId, eventId), eq(threads.kind, "vendor"), eq(threads.vendorId, key.id));
  const [found] = await db.select().from(threads).where(where);
  if (found) return found;
  if (key.kind === "function") {
    const [f] = await db.select({ id: functions.id }).from(functions).where(and(eq(functions.id, key.id), eq(functions.eventId, eventId)));
    if (!f) throw new ChatError("not_found");
  }
  if (key.kind === "vendor") {
    const [v] = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, key.id), eq(vendors.eventId, eventId)));
    if (!v) throw new ChatError("not_found");
  }
  await db
    .insert(threads)
    .values({
      eventId,
      kind: key.kind,
      functionId: key.kind === "function" ? key.id : null,
      vendorId: key.kind === "vendor" ? key.id : null,
    })
    .onConflictDoNothing();
  const [created] = await db.select().from(threads).where(where);
  return created;
}

/** A thread's display name parts: function or vendor name (the team thread has none). */
export async function threadTitle(db: Tx, thread: Thread): Promise<string | null> {
  if (thread.kind === "function" && thread.functionId) {
    const [f] = await db.select({ name: functions.name }).from(functions).where(eq(functions.id, thread.functionId));
    return f?.name ?? null;
  }
  if (thread.kind === "vendor" && thread.vendorId) {
    const [v] = await db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, thread.vendorId));
    return v?.name ?? null;
  }
  return null;
}

/** User ids who can read a thread: all members, plus the vendor's logins on a vendor thread. */
export async function threadAudience(db: Tx, thread: Thread): Promise<{ members: string[]; vendorUsers: string[] }> {
  const rows = await db.select({ userId: eventMembers.userId }).from(eventMembers).where(eq(eventMembers.eventId, thread.eventId));
  const vendorUsers = thread.kind === "vendor" && thread.vendorId ? await vendorUserIds(db, [thread.vendorId]) : [];
  return { members: rows.map((r) => r.userId), vendorUsers };
}

/** People who can be @mentioned in a thread (same as the audience), with names. */
export async function mentionCandidates(db: Tx, thread: Thread) {
  const { members, vendorUsers } = await threadAudience(db, thread);
  const ids = [...new Set([...members, ...vendorUsers])];
  if (ids.length === 0) return [];
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return rows.filter((r) => r.name).map((r) => ({ id: r.id, name: r.name as string, vendor: vendorUsers.includes(r.id) && !members.includes(r.id) }));
}

export type ThreadListItem = {
  key: string;
  kind: "team" | "function" | "vendor";
  name: string | null;
  date: string | null;
  threadId: string | null;
  lastMessageAt: Date | null;
  unread: number;
};

/**
 * Threads a member can open: Team, each function, and each vendor that has a thread, a quote
 * request or a booking. Unread = others' messages after the member's last read position.
 */
export async function listThreadsForMember(db: Tx, eventId: string, userId: string): Promise<ThreadListItem[]> {
  const existing = await db
    .select({
      id: threads.id,
      kind: threads.kind,
      functionId: threads.functionId,
      vendorId: threads.vendorId,
      lastMessageAt: threads.lastMessageAt,
      unread: sql<number>`(select count(*)::int from ${messages} m where m.thread_id = "threads"."id" and m.deleted_at is null
        and m.seq > coalesce((select r.last_read_seq from ${threadReads} r where r.thread_id = "threads"."id" and r.user_id = ${userId}), 0)
        and m.author_user_id is distinct from ${userId})`,
    })
    .from(threads)
    .where(eq(threads.eventId, eventId));
  const fns = await db
    .select({ id: functions.id, name: functions.name, date: functions.date })
    .from(functions)
    .where(eq(functions.eventId, eventId))
    .orderBy(asc(functions.date), asc(functions.startTime), asc(functions.name));
  const vs = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(
      and(
        eq(vendors.eventId, eventId),
        isNull(vendors.archivedAt),
        sql`(exists (select 1 from ${threads} t where t.vendor_id = "vendors"."id")
          or exists (select 1 from ${quoteRequests} q where q.vendor_id = "vendors"."id")
          or exists (select 1 from ${bookings} b where b.vendor_id = "vendors"."id"))`,
      ),
    )
    .orderBy(asc(vendors.name));
  const team = existing.find((t) => t.kind === "team");
  const out: ThreadListItem[] = [
    { key: "team", kind: "team", name: null, date: null, threadId: team?.id ?? null, lastMessageAt: team?.lastMessageAt ?? null, unread: team?.unread ?? 0 },
  ];
  for (const f of fns) {
    const t = existing.find((x) => x.kind === "function" && x.functionId === f.id);
    out.push({ key: `f.${f.id}`, kind: "function", name: f.name, date: f.date, threadId: t?.id ?? null, lastMessageAt: t?.lastMessageAt ?? null, unread: t?.unread ?? 0 });
  }
  for (const v of vs) {
    const t = existing.find((x) => x.kind === "vendor" && x.vendorId === v.id);
    out.push({ key: `v.${v.id}`, kind: "vendor", name: v.name, date: null, threadId: t?.id ?? null, lastMessageAt: t?.lastMessageAt ?? null, unread: t?.unread ?? 0 });
  }
  return out;
}

/** Total unread chat messages for a member across an event's threads. */
export async function unreadForMember(db: Tx, eventId: string, userId: string) {
  return (await listThreadsForMember(db, eventId, userId)).reduce((s, t) => s + t.unread, 0);
}

export type ChatMessage = {
  id: string;
  seq: number;
  authorName: string;
  authorKind: "member" | "vendor";
  mine: boolean;
  body: string;
  deleted: boolean;
  createdAt: string;
  attachments: { id: string; filename: string }[];
};

async function toChatMessages(db: Tx, rows: (typeof messages.$inferSelect)[], viewerId: string, vendorName: string | null): Promise<ChatMessage[]> {
  if (rows.length === 0) return [];
  const authorIds = [...new Set(rows.map((r) => r.authorUserId).filter((x): x is string => !!x))];
  const names = authorIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, authorIds)) : [];
  const docs = await db
    .select({ id: documents.id, filename: documents.filename, messageId: documents.messageId })
    .from(documents)
    .where(inArray(documents.messageId, rows.map((r) => r.id)));
  return rows.map((r) => {
    const name = names.find((n) => n.id === r.authorUserId)?.name ?? "";
    const authorName = r.authorKind === "vendor" ? (name && vendorName ? `${name} (${vendorName})` : name || vendorName || "") : name;
    return {
      id: r.id,
      seq: r.seq,
      authorName,
      authorKind: r.authorKind,
      mine: r.authorUserId === viewerId,
      body: r.deletedAt ? "" : r.body,
      deleted: !!r.deletedAt,
      createdAt: r.createdAt.toISOString(),
      attachments: r.deletedAt ? [] : docs.filter((d) => d.messageId === r.id).map((d) => ({ id: d.id, filename: d.filename })),
    };
  });
}

async function vendorNameOf(db: Tx, thread: Thread) {
  if (thread.kind !== "vendor" || !thread.vendorId) return null;
  const [v] = await db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, thread.vendorId));
  return v?.name ?? null;
}

/** The latest page of a thread, oldest first. */
export async function latestMessages(db: Tx, thread: Thread, viewer: ChatViewer, limit = 50): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, thread.id))
    .orderBy(desc(messages.seq))
    .limit(Math.min(limit, PAGE));
  return toChatMessages(db, rows.reverse(), viewer.userId, await vendorNameOf(db, thread));
}

/**
 * Polling (ADR-0026): messages with seq > afterSeq, oldest first, plus ids of messages deleted in
 * the range the client already shows (fromSeq..afterSeq). Posting locks the thread row, so seqs in
 * one thread become visible in order and a cursor never skips a message.
 */
export async function messagesAfter(db: Tx, thread: Thread, viewer: ChatViewer, afterSeq: number, fromSeq = afterSeq) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), gt(messages.seq, afterSeq)))
    .orderBy(asc(messages.seq))
    .limit(PAGE);
  const deleted =
    fromSeq <= afterSeq
      ? await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.threadId, thread.id), sql`${messages.seq} >= ${fromSeq}`, lte(messages.seq, afterSeq), sql`${messages.deletedAt} is not null`))
      : [];
  const list = await toChatMessages(db, rows, viewer.userId, await vendorNameOf(db, thread));
  return { messages: list, deleted: deleted.map((d) => d.id), cursor: list.length ? list[list.length - 1].seq : afterSeq, more: rows.length === PAGE };
}

export async function markRead(db: Tx, threadId: string, userId: string, seq: number) {
  await db
    .insert(threadReads)
    .values({ threadId, userId, lastReadSeq: seq })
    .onConflictDoUpdate({ target: [threadReads.threadId, threadReads.userId], set: { lastReadSeq: sql`greatest(${threadReads.lastReadSeq}, ${seq})` } });
}

const snippet = (body: string) => (body.length > 80 ? `${body.slice(0, 79)}…` : body);

/**
 * Posts a message. Mentions are kept only for users in the thread's audience. Mentioned users get a
 * "mention" notification; the rest of the audience gets one "new message" notification per thread
 * until they read it (no pile-up).
 */
export async function postMessage(
  db: Database,
  eventId: string,
  key: ThreadKey,
  viewer: ChatViewer,
  input: { body: string; mentions?: string[]; withAttachment?: boolean },
) {
  const body = (input.body ?? "").trim();
  if (body.length > MAX_MESSAGE_CHARS) throw new ChatError("too_long");
  if (!body && !input.withAttachment) throw new ChatError("invalid");
  return db.transaction(async (tx) => {
    const opened = await openThread(tx, eventId, key, viewer);
    // Serialise posts per thread so seqs commit in order (polling never skips one).
    const [thread] = await tx.select().from(threads).where(eq(threads.id, opened.id)).for("update");
    const { members, vendorUsers } = await threadAudience(tx, thread);
    const audience = new Set([...members, ...vendorUsers]);
    const mentions = [...new Set((input.mentions ?? []).filter((id) => isUuid(id) && audience.has(id) && id !== viewer.userId))];
    const [msg] = await tx
      .insert(messages)
      .values({ eventId, threadId: thread.id, authorUserId: viewer.userId, authorKind: viewer.kind, body, mentionUserIds: mentions })
      .returning();
    await tx.update(threads).set({ lastMessageAt: msg.createdAt }).where(eq(threads.id, thread.id));
    await markRead(tx, thread.id, viewer.userId, msg.seq);

    const [author] = await tx.select({ name: users.name }).from(users).where(eq(users.id, viewer.userId));
    const [ev] = await tx.select({ name: events.name }).from(events).where(eq(events.id, eventId));
    const title = (await threadTitle(tx, thread)) ?? ev?.name ?? "";
    const vendorName = await vendorNameOf(tx, thread);
    const authorName = author?.name || vendorName || "";
    const key2 = threadKeyOf(thread);
    const memberHref = `/events/${eventId}/messages/${key2}`;
    const vendorHref = thread.vendorId ? `/vendor/${thread.vendorId}/messages` : null;
    const hrefFor = (uid: string) => (members.includes(uid) ? memberHref : vendorHref);

    const text = snippet(body);
    for (const uid of mentions) {
      await notify(tx, { userIds: [uid], eventId, kind: "mention", data: { author: authorName, thread: title, snippet: text }, href: hrefFor(uid) });
    }
    const others = [...audience].filter((id) => id !== viewer.userId && !mentions.includes(id));
    if (others.length) {
      // One unread "new message" notification per thread and person is enough.
      const already = await tx
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(
          and(
            inArray(notifications.userId, others),
            inArray(notifications.kind, ["chat.message", "vendor.message"]),
            inArray(notifications.href, [memberHref, ...(vendorHref ? [vendorHref] : [])]),
            isNull(notifications.readAt),
          ),
        );
      const skip = new Set(already.map((a) => a.userId));
      const memberTargets = others.filter((id) => members.includes(id) && !skip.has(id));
      const vendorTargets = others.filter((id) => !members.includes(id) && !skip.has(id));
      if (memberTargets.length)
        await notify(tx, { userIds: memberTargets, eventId, kind: "chat.message", data: { author: authorName, thread: title }, href: memberHref });
      if (vendorTargets.length && vendorHref)
        await notify(tx, { userIds: vendorTargets, eventId, kind: "vendor.message", data: { author: authorName }, href: vendorHref });
    }
    return { message: msg, thread };
  });
}

/** Removes a message the author posted (a soft delete; attachments are deleted). */
export async function deleteOwnMessage(db: Database, eventId: string, viewer: ChatViewer, messageId: string) {
  if (!isUuid(messageId)) throw new ChatError("not_found");
  await db.transaction(async (tx) => {
    await assertViewer(tx, eventId, viewer);
    const [msg] = await tx
      .select({ m: messages, t: threads })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(and(eq(messages.id, messageId), eq(messages.eventId, eventId), isNull(messages.deletedAt)));
    if (!msg || msg.m.authorUserId !== viewer.userId) throw new ChatError("not_found");
    if (viewer.kind === "vendor" && msg.t.vendorId !== viewer.vendorId) throw new ChatError("not_found");
    await tx.update(messages).set({ deletedAt: new Date(), body: "" }).where(eq(messages.id, messageId));
    await tx.delete(documents).where(and(eq(documents.messageId, messageId), eq(documents.eventId, eventId)));
    await audit(tx, { eventId, actor: actorOfViewer(viewer), action: "chat.message_deleted", entityType: "message", entityId: messageId });
  });
}

/** Removes a just-posted message when its attachment couldn't be saved. */
export async function discardMessage(db: Tx, eventId: string, messageId: string, userId: string) {
  await db.delete(messages).where(and(eq(messages.id, messageId), eq(messages.eventId, eventId), eq(messages.authorUserId, userId)));
}

/**
 * An attachment a viewer may download: it must belong to a message in a thread the viewer can
 * read (vendors: their own thread only).
 */
export async function attachmentForViewer(db: Tx, eventId: string, viewer: ChatViewer, documentId: string) {
  if (!isUuid(documentId)) throw new ChatError("not_found");
  await assertViewer(db, eventId, viewer);
  const [row] = await db
    .select({ docId: documents.id, kind: threads.kind, vendorId: threads.vendorId })
    .from(documents)
    .innerJoin(messages, eq(messages.id, documents.messageId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(and(eq(documents.id, documentId), eq(documents.eventId, eventId), isNull(messages.deletedAt)));
  if (!row) throw new ChatError("not_found");
  if (viewer.kind === "vendor" && (row.kind !== "vendor" || row.vendorId !== viewer.vendorId)) throw new ChatError("not_found");
  return row.docId;
}

/** Opening a thread clears its chat notifications (mentions and "new message") for that person. */
export async function clearThreadNotifications(db: Tx, userId: string, href: string) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.href, href),
        inArray(notifications.kind, ["chat.message", "vendor.message", "mention"]),
        isNull(notifications.readAt),
      ),
    );
}
