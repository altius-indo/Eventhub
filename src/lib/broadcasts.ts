import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  broadcasts,
  events,
  functionInvites,
  functions,
  guests,
  guestTravel,
  hotels,
  households,
  outboundMessages,
  roomAssignments,
  roomBlocks,
  rooms,
  rsvps,
  type Broadcast,
  type BroadcastSegment,
  type MessageChannel,
} from "@/db/schema";
import { createTranslator, type Locale } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import { hmac, safeEqual } from "./crypto";
import { guestLinkUrl } from "./guest-links";
import { isUuid } from "./ids";
import { CHANNELS, enqueue, estimate, normalizeAddress, optOut, QuotaError, registerTemplate, type EnqueueItem, type Estimate } from "./outbox";

/**
 * Guest broadcasts (MSG-02) with a pre-send estimate (LIM-02). A broadcast is a draft until sent;
 * sending queues one message per family (or per adult) in one transaction, refused as a whole when
 * a channel's limit can't take it (LIM-03). Texts are rendered at send time in the family's
 * language, with the family's own guest link, so no link is ever stored.
 */

export class BroadcastError extends Error {
  constructor(
    public code: "not_found" | "invalid" | "not_draft" | "no_recipients" | "quota",
    public channel?: MessageChannel,
  ) {
    super(code);
  }
}

const RSVP_VALUES = ["attending", "maybe", "declined", "pending"] as const;
const TRAVEL_VALUES = ["needs_pickup", "self", "none"] as const;
const SIDES = ["bride", "groom", "both"] as const;

export const segmentSchema = z.object({
  sides: z.array(z.enum(SIDES)).max(3).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  functionIds: z.array(z.string().uuid()).max(100).optional(),
  rsvp: z.array(z.enum(RSVP_VALUES)).max(4).optional(),
  travel: z.array(z.enum(TRAVEL_VALUES)).max(3).optional(),
  hotelIds: z.array(z.string().uuid()).max(50).optional(),
  allAdults: z.boolean().optional(),
});

export const broadcastSchema = z.object({
  title: z.string().trim().min(1).max(120),
  bodyEn: z.string().trim().min(1).max(1000),
  bodyHi: z.string().trim().max(1000).optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).max(3),
  segment: segmentSchema,
});
export type BroadcastInput = z.infer<typeof broadcastSchema>;

function cleanSegment(s: z.infer<typeof segmentSchema>): BroadcastSegment {
  const out: BroadcastSegment = {};
  if (s.sides?.length) out.sides = [...new Set(s.sides)];
  if (s.tags?.length) out.tags = [...new Set(s.tags)];
  if (s.functionIds?.length) out.functionIds = [...new Set(s.functionIds)];
  if (s.rsvp?.length) out.rsvp = [...new Set(s.rsvp)];
  if (s.travel?.length) out.travel = [...new Set(s.travel)];
  if (s.hotelIds?.length) out.hotelIds = [...new Set(s.hotelIds)];
  if (s.allAdults) out.allAdults = true;
  return out;
}

async function checkSegmentIds(db: Tx, eventId: string, s: BroadcastSegment) {
  if (s.functionIds?.length) {
    const rows = await db.select({ id: functions.id }).from(functions).where(and(eq(functions.eventId, eventId), inArray(functions.id, s.functionIds)));
    if (rows.length !== s.functionIds.length) throw new BroadcastError("invalid");
  }
  if (s.hotelIds?.length) {
    const rows = await db.select({ id: hotels.id }).from(hotels).where(and(eq(hotels.eventId, eventId), inArray(hotels.id, s.hotelIds)));
    if (rows.length !== s.hotelIds.length) throw new BroadcastError("invalid");
  }
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/**
 * Families matching a segment. Different filters combine with AND; values inside one filter with OR.
 * A family matches a guest-level filter when any of its members does. RSVP statuses apply to the
 * chosen functions (or any function when none is chosen); "pending" = invited, no answer yet.
 */
export async function resolveSegment(db: Tx, eventId: string, segment: BroadcastSegment): Promise<string[]> {
  const conds: SQL[] = [eq(households.eventId, eventId)];
  const fnIds = segment.functionIds ?? [];
  const fnFilter = (col: SQL | typeof functionInvites.functionId) =>
    fnIds.length ? sql` and ${col} in (${sql.join(fnIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;

  if (segment.sides?.length) conds.push(inArray(households.side, segment.sides as (typeof SIDES)[number][]));
  if (segment.tags?.length) {
    const tags = sql`array[${sql.join(segment.tags.map((t) => sql`${t}`), sql`, `)}]::text[]`;
    conds.push(sql`exists (select 1 from ${guests} g where g.household_id = "households"."id" and g.tags && ${tags})`);
  }
  if (fnIds.length) {
    conds.push(
      sql`exists (select 1 from ${functionInvites} fi join ${guests} g on g.id = fi.guest_id where g.household_id = "households"."id"${fnFilter(sql`fi.function_id`)})`,
    );
  }
  if (segment.rsvp?.length) {
    const parts: SQL[] = [];
    const answered = segment.rsvp.filter((r) => r !== "pending");
    if (answered.length) {
      parts.push(
        sql`exists (select 1 from ${functionInvites} fi join ${guests} g on g.id = fi.guest_id
          join ${rsvps} r on r.guest_id = fi.guest_id and r.function_id = fi.function_id
          where g.household_id = "households"."id" and r.status in (${sql.join(answered.map((a) => sql`${a}::rsvp_status`), sql`, `)})${fnFilter(sql`fi.function_id`)})`,
      );
    }
    if (segment.rsvp.includes("pending")) {
      parts.push(
        sql`exists (select 1 from ${functionInvites} fi join ${guests} g on g.id = fi.guest_id
          where g.household_id = "households"."id"${fnFilter(sql`fi.function_id`)}
          and not exists (select 1 from ${rsvps} r where r.guest_id = fi.guest_id and r.function_id = fi.function_id))`,
      );
    }
    conds.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (segment.travel?.length) {
    const parts: SQL[] = [];
    if (segment.travel.includes("needs_pickup"))
      parts.push(sql`exists (select 1 from ${guestTravel} tr join ${guests} g on g.id = tr.guest_id where g.household_id = "households"."id" and tr.needs_pickup)`);
    if (segment.travel.includes("self"))
      parts.push(
        sql`exists (select 1 from ${guestTravel} tr join ${guests} g on g.id = tr.guest_id where g.household_id = "households"."id" and not tr.needs_pickup)`,
      );
    if (segment.travel.includes("none"))
      parts.push(sql`not exists (select 1 from ${guestTravel} tr join ${guests} g on g.id = tr.guest_id where g.household_id = "households"."id")`);
    conds.push(sql`(${sql.join(parts, sql` or `)})`);
  }
  if (segment.hotelIds?.length) {
    conds.push(
      sql`exists (select 1 from ${roomAssignments} ra join ${rooms} rm on rm.id = ra.room_id join ${roomBlocks} rb on rb.id = rm.block_id
        join ${guests} g on g.id = ra.guest_id
        where g.household_id = "households"."id" and rb.hotel_id in (${sql.join(segment.hotelIds.map((id) => sql`${id}::uuid`), sql`, `)}))`,
    );
  }
  const rows = await db
    .select({ id: households.id })
    .from(households)
    .where(and(...conds))
    .orderBy(asc(households.name));
  return rows.map((r) => r.id);
}

type Contact = { guestId: string; phone: string | null; email: string | null };

/**
 * Who in each family gets the message: the head if they have a phone or email, else the first
 * adult who does. With `allAdults`, every adult with a phone or email (one message each).
 */
export async function recipientsFor(db: Tx, eventId: string, householdIds: string[], allAdults = false) {
  if (householdIds.length === 0) return new Map<string, Contact[]>();
  const rows = await db
    .select({ id: guests.id, householdId: guests.householdId, isHead: guests.isHead, ageGroup: guests.ageGroup, phone: guests.phone, email: guests.email })
    .from(guests)
    .where(and(eq(guests.eventId, eventId), inArray(guests.householdId, householdIds)))
    .orderBy(desc(guests.isHead), asc(guests.sortOrder), asc(guests.createdAt));
  const out = new Map<string, Contact[]>();
  for (const hid of householdIds) {
    const members = rows.filter((g) => g.householdId === hid);
    const reachable = members.filter((g) => (g.phone?.trim() || g.email?.trim()) && (g.isHead || g.ageGroup === "adult"));
    const chosen = allAdults ? reachable : reachable.slice(0, 1);
    out.set(
      hid,
      chosen.map((g) => ({ guestId: g.id, phone: g.phone?.trim() || null, email: g.email?.trim() || null })),
    );
  }
  return out;
}

const PREFERRED = new Set<string>(CHANNELS);

/** The queue items a broadcast would send (also used for the estimate). */
export async function broadcastItems(db: Tx, b: Broadcast, appUrl: string): Promise<EnqueueItem[]> {
  const ids = await resolveSegment(db, b.eventId, b.segment);
  if (ids.length === 0) return [];
  const hh = await db
    .select({ id: households.id, locale: households.locale, preferred: households.preferredChannel })
    .from(households)
    .where(inArray(households.id, ids));
  const contacts = await recipientsFor(db, b.eventId, ids, !!b.segment.allAdults);
  const items: EnqueueItem[] = [];
  for (const h of hh) {
    const list = contacts.get(h.id) ?? [];
    // A family with nobody reachable still counts (as "no address") in the estimate.
    const people: (Contact | null)[] = list.length ? list : [null];
    for (const c of people) {
      items.push({
        eventId: b.eventId,
        purpose: "broadcast",
        templateKey: "broadcast",
        vars: { appUrl },
        recipient: {
          householdId: h.id,
          guestId: c?.guestId ?? null,
          addresses: { whatsapp: c?.phone ?? null, sms: c?.phone ?? null, email: c?.email ?? null },
          locale: h.locale,
          preferred: h.preferred && PREFERRED.has(h.preferred) ? (h.preferred as MessageChannel) : null,
        },
        channels: b.channels,
        bulk: true,
        key: b.segment.allAdults && c ? `b:${b.id}:${h.id}:${c.guestId}` : `b:${b.id}:${h.id}`,
        broadcastId: b.id,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Unsubscribe links (/u/<token>)
// ---------------------------------------------------------------------------

const unsubMac = (payload: string) => hmac(`unsubscribe:${payload}`).slice(0, 32);

/** A signed token naming (event, channel, address); nothing is stored. */
export function makeUnsubscribeToken(eventId: string, channel: MessageChannel, address: string): string {
  const payload = `${eventId}|${channel}|${normalizeAddress(channel, address)}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${unsubMac(payload)}`;
}

export function readUnsubscribeToken(token: string): { eventId: string; channel: MessageChannel; address: string } | null {
  if (typeof token !== "string" || token.length > 600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const [p, sig] = token.split(".");
  const payload = Buffer.from(p, "base64url").toString("utf8");
  if (!safeEqual(sig, unsubMac(payload))) return null;
  const [eventId, channel, address] = payload.split("|");
  if (!isUuid(eventId) || !(CHANNELS as readonly string[]).includes(channel) || !address) return null;
  return { eventId, channel: channel as MessageChannel, address };
}

/** Opts the address out of broadcasts; returns nothing either way (same response for any token). */
export async function unsubscribe(db: Tx, token: string): Promise<void> {
  const t = readUnsubscribeToken(token);
  if (!t) return;
  const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.id, t.eventId));
  if (!ev) return;
  await optOut(db, t.eventId, t.channel, t.address, "unsubscribe_link");
}

// ---------------------------------------------------------------------------
// Rendering (at send time)
// ---------------------------------------------------------------------------

export function bodyFor(b: Pick<Broadcast, "body">, locale: Locale) {
  return locale === "hi" && b.body.hi?.trim() ? b.body.hi : b.body.en;
}

registerTemplate("broadcast", async (vars, locale, { db, row }) => {
  const t = createTranslator(locale);
  if (!row.broadcastId) throw new Error("broadcast template without broadcast");
  const [b] = await db.select().from(broadcasts).where(eq(broadcasts.id, row.broadcastId));
  if (!b) throw new Error("broadcast missing");
  const appUrl = String(vars.appUrl ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  const lines = [b.title, "", bodyFor(b, locale)];
  if (row.householdId) {
    const [h] = await db.select().from(households).where(and(eq(households.id, row.householdId), eq(households.eventId, b.eventId)));
    if (h && !h.linkRevokedAt) lines.push("", t("broadcasts.yourLink", { link: guestLinkUrl(appUrl, h) }));
  }
  if (row.channel === "email" && row.eventId) {
    lines.push("", t("broadcasts.unsubscribeLine", { link: `${appUrl}/u/${makeUnsubscribeToken(row.eventId, "email", row.toAddress)}` }));
  }
  return { subject: b.title, text: lines.join("\n") };
});

// ---------------------------------------------------------------------------
// Drafts, estimate, sending, stats
// ---------------------------------------------------------------------------

async function prepare(db: Tx, eventId: string, input: BroadcastInput) {
  const segment = cleanSegment(input.segment);
  await checkSegmentIds(db, eventId, segment);
  return {
    title: input.title,
    body: input.bodyHi ? { en: input.bodyEn, hi: input.bodyHi } : { en: input.bodyEn },
    channels: CHANNELS.filter((c) => input.channels.includes(c)),
    segment,
  };
}

export async function createDraft(db: Tx, eventId: string, actor: Actor, raw: BroadcastInput) {
  const parsed = broadcastSchema.safeParse(raw);
  if (!parsed.success) throw new BroadcastError("invalid");
  const [b] = await db
    .insert(broadcasts)
    .values({ eventId, ...(await prepare(db, eventId, parsed.data)), createdBy: actor.userId })
    .returning();
  return b;
}

export async function updateDraft(db: Tx, eventId: string, broadcastId: string, raw: BroadcastInput) {
  const parsed = broadcastSchema.safeParse(raw);
  if (!parsed.success) throw new BroadcastError("invalid");
  const b = await getBroadcast(db, eventId, broadcastId);
  if (b.status !== "draft") throw new BroadcastError("not_draft");
  const [u] = await db
    .update(broadcasts)
    .set(await prepare(db, eventId, parsed.data))
    .where(and(eq(broadcasts.id, b.id), eq(broadcasts.status, "draft")))
    .returning();
  if (!u) throw new BroadcastError("not_draft");
  return u;
}

export async function deleteDraft(db: Tx, eventId: string, broadcastId: string) {
  if (!isUuid(broadcastId)) throw new BroadcastError("not_found");
  const r = await db
    .delete(broadcasts)
    .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.eventId, eventId), eq(broadcasts.status, "draft")))
    .returning({ id: broadcasts.id });
  if (r.length === 0) throw new BroadcastError("not_draft");
}

export async function getBroadcast(db: Tx, eventId: string, broadcastId: string) {
  if (!isUuid(broadcastId)) throw new BroadcastError("not_found");
  const [b] = await db.select().from(broadcasts).where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.eventId, eventId)));
  if (!b) throw new BroadcastError("not_found");
  return b;
}

export async function listBroadcasts(db: Tx, eventId: string) {
  return db.select().from(broadcasts).where(eq(broadcasts.eventId, eventId)).orderBy(desc(broadcasts.createdAt)).limit(200);
}

export type BroadcastEstimate = Estimate & { households: number; messages: number };

/** LIM-02: recipients per channel, who can't be reached and why, and what's left of each limit. */
export async function estimateBroadcast(db: Tx, b: Broadcast, appUrl: string): Promise<BroadcastEstimate> {
  const items = await broadcastItems(db, b, appUrl);
  const est = await estimate(db, b.eventId, items);
  const households = new Set(items.map((i) => i.recipient.householdId)).size;
  return { ...est, households, messages: CHANNELS.reduce((s, c) => s + est.byChannel[c], 0) };
}

/**
 * Queues a draft in one transaction: refused as a whole if a channel's limit can't take it.
 * The caller then calls drainSoon().
 */
export async function sendBroadcast(db: Database, eventId: string, broadcastId: string, actor: Actor, appUrl: string) {
  if (!isUuid(broadcastId)) throw new BroadcastError("not_found");
  try {
    return await db.transaction(async (tx) => {
      const [b] = await tx
        .select()
        .from(broadcasts)
        .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.eventId, eventId)))
        .for("update");
      if (!b) throw new BroadcastError("not_found");
      if (b.status !== "draft") throw new BroadcastError("not_draft");
      const items = await broadcastItems(tx, b, appUrl);
      const res = await enqueue(tx, items);
      if (res.queued === 0) throw new BroadcastError("no_recipients");
      const [u] = await tx
        .update(broadcasts)
        .set({ status: "queued", recipientCount: res.queued, queuedAt: new Date() })
        .where(eq(broadcasts.id, b.id))
        .returning();
      await audit(tx, {
        eventId,
        actor,
        action: "broadcast.sent",
        entityType: "broadcast",
        entityId: b.id,
        data: { title: b.title, count: res.queued },
      });
      return { broadcast: u, ...res };
    });
  } catch (e) {
    if (e instanceof QuotaError) throw new BroadcastError("quota", e.channel);
    throw e;
  }
}

export const STAT_KEYS = ["queued", "sent", "delivered", "failed", "skipped"] as const;
export type BroadcastStats = Record<MessageChannel, Record<(typeof STAT_KEYS)[number], number>>;

/** Delivery stats per channel from the outbox (fallback messages count on their own channel). */
export async function broadcastStats(db: Tx, eventId: string, broadcastId: string): Promise<BroadcastStats> {
  const rows = await db
    .select({ channel: outboundMessages.channel, status: outboundMessages.status, n: sql<number>`count(*)::int` })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.eventId, eventId), eq(outboundMessages.broadcastId, broadcastId)))
    .groupBy(outboundMessages.channel, outboundMessages.status);
  const out = Object.fromEntries(CHANNELS.map((c) => [c, { queued: 0, sent: 0, delivered: 0, failed: 0, skipped: 0 }])) as BroadcastStats;
  for (const r of rows) {
    const s = out[r.channel];
    if (r.status === "queued" || r.status === "sending") s.queued += r.n;
    else if (r.status === "sent") s.sent += r.n;
    else if (r.status === "delivered") s.delivered += r.n;
    else if (r.status === "failed") s.failed += r.n;
    else s.skipped += r.n;
  }
  return out;
}

/** Options for the segment picker: tags in use, functions and hotels. */
export async function segmentOptions(db: Tx, eventId: string) {
  const tagRows = await db.execute(sql`select distinct unnest(tags) as tag from ${guests} where event_id = ${eventId} order by 1 limit 200`);
  const fns = await db
    .select({ id: functions.id, name: functions.name, date: functions.date })
    .from(functions)
    .where(eq(functions.eventId, eventId))
    .orderBy(asc(functions.date), asc(functions.startTime));
  const hs = await db.select({ id: hotels.id, name: hotels.name }).from(hotels).where(eq(hotels.eventId, eventId)).orderBy(asc(hotels.name));
  return { tags: (tagRows.rows as { tag: string }[]).map((r) => r.tag), functions: fns, hotels: hs };
}

