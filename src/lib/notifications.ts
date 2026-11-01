import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db";
import { eventMembers, events, notificationPrefs, notifications, userIdentifiers, users, vendorContacts, vendors, type NotificationRow } from "@/db/schema";
import { isLocale, translateDynamic, type Locale } from "@/i18n/core";
import { cancelQueued, enqueue } from "./outbox";

/**
 * In-app notifications (MSG-05, ADR-0029). Rows hold a kind and ids/values; the text is
 * rendered when read, in the reader's language. In-app is always on; email per category.
 */

export const CATEGORIES = ["mentions", "chat", "approvals", "payments", "tasks", "headcount", "usage", "vendors", "gifts"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Email on by default for these; others are in-app only unless the user opts in. */
const EMAIL_DEFAULT: Record<Category, boolean> = {
  mentions: true,
  chat: false,
  approvals: true,
  payments: true,
  tasks: false,
  headcount: true,
  usage: true,
  vendors: true,
  gifts: false,
};

export function categoryOf(kind: string): Category {
  const head = kind.split(".")[0];
  const map: Record<string, Category> = {
    mention: "mentions",
    chat: "chat",
    approval: "approvals",
    payment: "payments",
    task: "tasks",
    headcount: "headcount",
    usage: "usage",
    vendor: "vendors",
    gift: "gifts",
    thank_you: "gifts",
  };
  return map[head] ?? "chat";
}

export type NotifyInput = {
  kind: string;
  /** In-app only, whatever the user's email preference (e.g. the daily digest already emails it). */
  noEmail?: boolean;
  data?: Record<string, string | number | null>;
  href?: string | null;
};

/** Renders a notification in a language (key `notifications.kinds.<kind>`). */
export function renderNotification(locale: Locale, n: Pick<NotificationRow, "kind" | "data">): string {
  return translateDynamic(locale, `notifications.kinds.${n.kind}`, Object.fromEntries(Object.entries(n.data ?? {}).map(([k, v]) => [k, v ?? ""]))) ?? n.kind;
}

async function emailPrefs(db: Tx, userIds: string[], category: Category) {
  const rows = userIds.length
    ? await db.select().from(notificationPrefs).where(and(inArray(notificationPrefs.userId, userIds), eq(notificationPrefs.category, category)))
    : [];
  return new Map(userIds.map((id) => [id, rows.find((r) => r.userId === id)?.email ?? EMAIL_DEFAULT[category]]));
}

/** Creates notifications for users (deduplicated) and queues an email where they want one. */
export async function notify(db: Tx, input: NotifyInput & { userIds: string[]; eventId: string | null; appUrl?: string; exceptUserId?: string | null }) {
  const ids = [...new Set(input.userIds)].filter((id) => id && id !== input.exceptUserId);
  if (ids.length === 0) return [];
  const rows = await db
    .insert(notifications)
    .values(ids.map((userId) => ({ userId, eventId: input.eventId, kind: input.kind, data: input.data ?? {}, href: input.href ?? null })))
    .returning();
  if (input.noEmail) return rows;
  const category = categoryOf(input.kind);
  const wants = await emailPrefs(db, ids, category);
  const targets = ids.filter((id) => wants.get(id));
  if (targets.length === 0) return rows;
  const people = await db.select({ id: users.id, locale: users.locale, suspendedAt: users.suspendedAt }).from(users).where(inArray(users.id, targets));
  const emails = await db.select().from(userIdentifiers).where(and(inArray(userIdentifiers.userId, targets), eq(userIdentifiers.type, "email")));
  const [ev] = input.eventId ? await db.select({ name: events.name }).from(events).where(eq(events.id, input.eventId)) : [];
  const base = (input.appUrl ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  await enqueue(
    db,
    rows
      .map((n) => {
        const person = people.find((p) => p.id === n.userId);
        const email = emails.find((e) => e.userId === n.userId)?.value;
        if (!person || person.suspendedAt || !email) return null;
        const locale: Locale = isLocale(person.locale) ? person.locale : "en";
        const text = renderNotification(locale, n);
        const subject = ev ? `${ev.name} · EventHub` : "EventHub";
        return {
          eventId: input.eventId,
          purpose: "notification",
          templateKey: "plain",
          vars: { subject, text: n.href ? `${text}\n${base}${n.href}` : text },
          recipient: { userId: n.userId, addresses: { email }, locale },
          channels: ["email" as const],
          bulk: false,
          key: `n:${n.id}`,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
  );
  return rows;
}

/** Notifies every Host of an event. */
export async function notifyHosts(db: Tx, eventId: string, input: NotifyInput & { exceptUserId?: string | null }) {
  const hosts = await db.select({ userId: eventMembers.userId }).from(eventMembers).where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.role, "host")));
  return notify(db, { ...input, eventId, userIds: hosts.map((h) => h.userId) });
}

/**
 * Notifications outlive access only as long as it lasts: event rows show while the user is still
 * a member, has a live vendor link to the event, or is an App Admin. Platform rows (no event) stay.
 */
const stillHasAccess = sql`(
  ${notifications.eventId} is null
  or exists (select 1 from ${eventMembers} em where em.event_id = ${notifications.eventId} and em.user_id = ${notifications.userId})
  or exists (
    select 1 from ${vendorContacts} vc join ${vendors} v on v.id = vc.vendor_id
    where vc.event_id = ${notifications.eventId} and vc.user_id = ${notifications.userId} and vc.revoked_at is null and v.archived_at is null
  )
  or exists (select 1 from ${users} u where u.id = ${notifications.userId} and u.is_app_admin)
)`;

export async function listNotifications(db: Tx, userId: string, opts: { limit?: number } = {}) {
  return db
    .select({ n: notifications, eventName: events.name })
    .from(notifications)
    .leftJoin(events, eq(events.id, notifications.eventId))
    .where(and(eq(notifications.userId, userId), stillHasAccess))
    .orderBy(desc(notifications.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

export async function unreadCount(db: Tx, userId: string) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), stillHasAccess));
  return n;
}

/** Deletes notifications matching `where`, and cancels their emails that haven't gone out yet. */
export async function removeNotifications(db: Tx, where: SQL) {
  const gone = await db.delete(notifications).where(where).returning({ id: notifications.id });
  if (gone.length) await cancelQueued(db, gone.map((n) => `n:${n.id}`));
  return gone.length;
}

/** A user's notifications for one event (when they lose access to it). */
export async function removeUserEventNotifications(db: Tx, userId: string, eventId: string) {
  return removeNotifications(db, and(eq(notifications.userId, userId), eq(notifications.eventId, eventId))!);
}

export async function markRead(db: Tx, userId: string, ids: string[] | "all") {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), ids === "all" ? undefined : inArray(notifications.id, ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])));
}

export async function getPrefs(db: Tx, userId: string): Promise<Record<Category, boolean>> {
  const rows = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId));
  return Object.fromEntries(CATEGORIES.map((c) => [c, rows.find((r) => r.category === c)?.email ?? EMAIL_DEFAULT[c]])) as Record<Category, boolean>;
}

export async function setPrefs(db: Tx, userId: string, prefs: Partial<Record<Category, boolean>>) {
  for (const c of CATEGORIES) {
    if (prefs[c] === undefined) continue;
    await db
      .insert(notificationPrefs)
      .values({ userId, category: c, email: prefs[c]! })
      .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.category], set: { email: prefs[c]! } });
  }
}

/** Notifications older than this are deleted by the daily job. */
export const NOTIFICATION_TTL_DAYS = 90;

export async function purgeOldNotifications(db: Tx, now = new Date()) {
  const cutoff = new Date(now.getTime() - NOTIFICATION_TTL_DAYS * 86_400_000);
  const res = await db.delete(notifications).where(sql`${notifications.createdAt} < ${cutoff.toISOString()}`).returning({ id: notifications.id });
  return res.length;
}
