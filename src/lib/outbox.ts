import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import {
  broadcasts,
  eventLimitOverrides,
  messageOptOuts,
  messageUsage,
  outboundMessages,
  platformSettings,
  type MessageChannel,
  type OutboundMessage,
} from "@/db/schema";
import { isLocale, type Locale } from "@/i18n/core";
import { channelConnected, DeliveryError, providerFor } from "./delivery";

/**
 * Outgoing message queue (ADR-0024) with per-event quotas (ADR-0025).
 *
 * Callers enqueue inside their own transaction; `processOutbox` sends in batches. It runs from
 * `after()` in the action that queued, from `/api/outbox/drain`, and from the daily cron.
 * OTP codes don't use this queue and never count against limits.
 */

export const CHANNELS = ["whatsapp", "email", "sms"] as const satisfies readonly MessageChannel[];
/** Default channel order for guest messages (§4.1). */
export const DEFAULT_ORDER: MessageChannel[] = ["whatsapp", "email", "sms"];
export const DEFAULT_LIMITS: Record<MessageChannel, number> = { whatsapp: 15_000, sms: 3_000, email: 50_000 };
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
export const MAX_ATTEMPTS = 4;
/** Purposes a guest can opt out of (broadcasts, thank-you notes); transactional messages still go. */
export const OPT_OUTABLE = new Set(["broadcast", "thank_you"]);

export class QuotaError extends Error {
  constructor(public channel: MessageChannel, public needed: number, public remaining: number) {
    super(`quota:${channel}`);
  }
}

// ---------------------------------------------------------------------------
// Templates: render text at send time (so guest links are never stored)
// ---------------------------------------------------------------------------

export type Rendered = { subject?: string; text: string };
export type TemplateFn = (vars: Record<string, string | number | null>, locale: Locale, ctx: { db: Tx; row: OutboundMessage }) => Promise<Rendered> | Rendered;
const templates = new Map<string, TemplateFn>();

export function registerTemplate(key: string, fn: TemplateFn) {
  templates.set(key, fn);
}

/** Pre-rendered text (e.g. notifications rendered in the user's language at enqueue). */
registerTemplate("plain", (vars) => ({ subject: vars.subject == null ? undefined : String(vars.subject), text: String(vars.text ?? "") }));

// ---------------------------------------------------------------------------
// Addresses, opt-outs and limits
// ---------------------------------------------------------------------------

export function normalizeAddress(channel: MessageChannel, address: string) {
  const a = address.trim();
  return channel === "email" ? a.toLowerCase() : a.replace(/[^\d+]/g, "");
}

export async function isOptedOut(db: Tx, eventId: string, channel: MessageChannel, address: string) {
  const [row] = await db
    .select({ a: messageOptOuts.address })
    .from(messageOptOuts)
    .where(and(eq(messageOptOuts.eventId, eventId), eq(messageOptOuts.channel, channel), eq(messageOptOuts.address, normalizeAddress(channel, address))));
  return !!row;
}

export async function optOut(db: Tx, eventId: string, channel: MessageChannel, address: string, source: string) {
  await db
    .insert(messageOptOuts)
    .values({ eventId, channel, address: normalizeAddress(channel, address), source })
    .onConflictDoNothing();
}

export async function optIn(db: Tx, eventId: string, channel: MessageChannel, address: string) {
  await db
    .delete(messageOptOuts)
    .where(and(eq(messageOptOuts.eventId, eventId), eq(messageOptOuts.channel, channel), eq(messageOptOuts.address, normalizeAddress(channel, address))));
}

export async function getLimits(db: Tx, eventId: string): Promise<Record<MessageChannel, number>> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, "limits"));
  const base = { ...DEFAULT_LIMITS, ...((row?.value as Partial<Record<MessageChannel, number>>) ?? {}) };
  const overrides = await db.select().from(eventLimitOverrides).where(eq(eventLimitOverrides.eventId, eventId));
  for (const o of overrides) base[o.channel] = o.limit;
  return base;
}

export type Usage = Record<MessageChannel, { used: number; reserved: number; limit: number; remaining: number; connected: boolean }>;

/** LIM-01: messages used per channel vs the event's limit. */
export async function getUsage(db: Tx, eventId: string): Promise<Usage> {
  const limits = await getLimits(db, eventId);
  const rows = await db.select().from(messageUsage).where(eq(messageUsage.eventId, eventId));
  const out = {} as Usage;
  for (const c of CHANNELS) {
    const r = rows.find((x) => x.channel === c);
    const used = r?.used ?? 0;
    const reserved = r?.reserved ?? 0;
    out[c] = { used, reserved, limit: limits[c], remaining: Math.max(0, limits[c] - used - reserved), connected: channelConnected(c) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planning and enqueueing
// ---------------------------------------------------------------------------

export type Recipient = {
  householdId?: string | null;
  guestId?: string | null;
  userId?: string | null;
  addresses: Partial<Record<MessageChannel, string | null>>;
  locale?: string | null;
  preferred?: MessageChannel | null;
};

export type EnqueueItem = {
  eventId: string | null;
  purpose: string;
  templateKey: string;
  vars: Record<string, string | number | null>;
  recipient: Recipient;
  /** Channels allowed for this message, in no particular order; the recipient's order applies. */
  channels?: MessageChannel[];
  /** Bulk sends (broadcasts, bulk thank-yous) are refused as a whole when over a limit. */
  bulk: boolean;
  /** Unique per logical message, e.g. `b:<broadcast>:<household>`. Re-enqueueing is a no-op. */
  key: string;
  broadcastId?: string | null;
  thankYouId?: string | null;
};

export type PlannedItem = { item: EnqueueItem; channel: MessageChannel | null; address: string | null; fallback: MessageChannel[]; reason?: "no_address" | "opted_out" | "unavailable" };

/** Picks each recipient's channel: preferred, else WhatsApp → email → SMS; skipping unusable ones. */
export async function planMessages(db: Tx, items: EnqueueItem[]): Promise<PlannedItem[]> {
  const out: PlannedItem[] = [];
  for (const item of items) {
    const allowed = new Set(item.channels ?? DEFAULT_ORDER);
    const order = [...new Set([item.recipient.preferred, ...DEFAULT_ORDER].filter((c): c is MessageChannel => !!c && allowed.has(c)))];
    const usable: MessageChannel[] = [];
    let reason: PlannedItem["reason"] = "no_address";
    for (const c of order) {
      const addr = item.recipient.addresses[c];
      if (!addr) continue;
      if (!channelConnected(c)) {
        reason = reason === "no_address" ? "unavailable" : reason;
        continue;
      }
      if (item.eventId && OPT_OUTABLE.has(item.purpose) && (await isOptedOut(db, item.eventId, c, addr))) {
        reason = "opted_out";
        continue;
      }
      usable.push(c);
    }
    const [first, ...rest] = usable;
    out.push(first ? { item, channel: first, address: normalizeAddress(first, item.recipient.addresses[first]!), fallback: rest } : { item, channel: null, address: null, fallback: [], reason });
  }
  return out;
}

export type Estimate = {
  byChannel: Record<MessageChannel, number>;
  skipped: { no_address: number; opted_out: number; unavailable: number };
  usage: Usage;
  overLimit: MessageChannel[];
};

/** LIM-02 pre-send estimate: what enqueueing these would send, per channel, against what's left. */
export async function estimate(db: Tx, eventId: string, items: EnqueueItem[]): Promise<Estimate> {
  const plan = await planMessages(db, items);
  const byChannel: Record<MessageChannel, number> = { whatsapp: 0, email: 0, sms: 0 };
  const skipped = { no_address: 0, opted_out: 0, unavailable: 0 };
  for (const p of plan) {
    if (p.channel) byChannel[p.channel]++;
    else skipped[p.reason ?? "no_address"]++;
  }
  const usage = await getUsage(db, eventId);
  const overLimit = CHANNELS.filter((c) => byChannel[c] > usage[c].remaining);
  return { byChannel, skipped, usage, overLimit };
}

async function reserve(db: Tx, eventId: string, channel: MessageChannel, n: number) {
  await db
    .insert(messageUsage)
    .values({ eventId, channel, reserved: n })
    .onConflictDoUpdate({ target: [messageUsage.eventId, messageUsage.channel], set: { reserved: sql`${messageUsage.reserved} + ${n}` } });
}

/**
 * Queues messages (in the caller's transaction). Bulk batches that don't fit in what's left of
 * a channel's limit are refused as a whole (QuotaError); one-to-one messages still go.
 */
export async function enqueue(db: Tx, items: EnqueueItem[]) {
  if (items.length === 0) return { queued: 0, skipped: 0, byChannel: { whatsapp: 0, email: 0, sms: 0 } as Record<MessageChannel, number> };
  const plan = await planMessages(db, items);
  const byEvent = new Map<string, Record<MessageChannel, number>>();
  for (const p of plan) {
    if (!p.channel || !p.item.eventId) continue;
    const m = byEvent.get(p.item.eventId) ?? { whatsapp: 0, email: 0, sms: 0 };
    m[p.channel]++;
    byEvent.set(p.item.eventId, m);
  }
  // Serialise quota checks per event.
  for (const [eventId, counts] of byEvent) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${eventId}`}))`);
    const usage = await getUsage(db, eventId);
    const bulk = plan.some((p) => p.item.bulk && p.item.eventId === eventId);
    if (bulk) for (const c of CHANNELS) if (counts[c] > usage[c].remaining) throw new QuotaError(c, counts[c], usage[c].remaining);
  }
  let queued = 0;
  let skipped = 0;
  const totals: Record<MessageChannel, number> = { whatsapp: 0, email: 0, sms: 0 };
  for (const p of plan) {
    if (!p.channel || !p.address) {
      skipped++;
      continue;
    }
    const addresses = Object.fromEntries(p.fallback.map((c) => [c, p.item.recipient.addresses[c] ?? null]));
    const inserted = await db
      .insert(outboundMessages)
      .values({
        eventId: p.item.eventId,
        purpose: p.item.purpose,
        broadcastId: p.item.broadcastId ?? null,
        thankYouId: p.item.thankYouId ?? null,
        householdId: p.item.recipient.householdId ?? null,
        guestId: p.item.recipient.guestId ?? null,
        userId: p.item.recipient.userId ?? null,
        channel: p.channel,
        toAddress: p.address,
        locale: isLocale(p.item.recipient.locale) ? p.item.recipient.locale : "en",
        templateKey: p.item.templateKey,
        vars: { ...p.item.vars, _fallback: p.fallback.join(","), _addr: JSON.stringify(addresses) },
        bulk: p.item.bulk,
        idempotencyKey: p.item.key,
      })
      .onConflictDoNothing({ target: outboundMessages.idempotencyKey })
      .returning({ id: outboundMessages.id });
    if (inserted.length === 0) continue;
    queued++;
    totals[p.channel]++;
    if (p.item.eventId) await reserve(db, p.item.eventId, p.channel, 1);
  }
  return { queued, skipped, byChannel: totals };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function settle(db: Tx, row: OutboundMessage, outcome: "sent" | "released") {
  if (!row.eventId) return;
  await db
    .update(messageUsage)
    .set(
      outcome === "sent"
        ? { reserved: sql`greatest(${messageUsage.reserved} - 1, 0)`, used: sql`${messageUsage.used} + 1` }
        : { reserved: sql`greatest(${messageUsage.reserved} - 1, 0)` },
    )
    .where(and(eq(messageUsage.eventId, row.eventId), eq(messageUsage.channel, row.channel)));
  if (outcome === "sent") await checkThresholds(db, row.eventId, row.channel);
}

/** LIM-03: warn Hosts once at 80% and once at 95% of a channel's limit. */
async function checkThresholds(db: Tx, eventId: string, channel: MessageChannel) {
  const usage = await getUsage(db, eventId);
  const u = usage[channel];
  const pct = u.limit > 0 ? u.used / u.limit : 1;
  for (const level of [95, 80] as const) {
    if (pct * 100 < level) continue;
    const col = level === 95 ? messageUsage.warned95At : messageUsage.warned80At;
    const marked = await db
      .update(messageUsage)
      .set(level === 95 ? { warned95At: new Date() } : { warned80At: new Date() })
      .where(and(eq(messageUsage.eventId, eventId), eq(messageUsage.channel, channel), sql`${col} is null`))
      .returning({ e: messageUsage.eventId });
    if (marked.length) {
      const { notifyHosts } = await import("./notifications");
      await notifyHosts(db, eventId, { kind: "usage.warning", data: { channel, pct: level }, href: `/events/${eventId}/usage` });
    }
    break;
  }
}

async function fallbackFrom(db: Tx, row: OutboundMessage) {
  const rest = String(row.vars._fallback ?? "")
    .split(",")
    .filter((c): c is MessageChannel => (CHANNELS as readonly string[]).includes(c));
  const [next, ...more] = rest;
  if (!next) return false;
  let addr: Record<string, string | null> = {};
  try {
    addr = JSON.parse(String(row.vars._addr ?? "{}"));
  } catch {
    addr = {};
  }
  const to = addr[next];
  if (!to) return false;
  await enqueue(db, [
    {
      eventId: row.eventId,
      purpose: row.purpose,
      templateKey: row.templateKey,
      vars: Object.fromEntries(Object.entries(row.vars).filter(([k]) => !k.startsWith("_"))),
      recipient: { householdId: row.householdId, guestId: row.guestId, userId: row.userId, addresses: { ...addr, [next]: to }, locale: row.locale, preferred: next },
      channels: [next, ...more],
      bulk: false,
      key: `${row.idempotencyKey}>${next}`,
      broadcastId: row.broadcastId,
      thankYouId: row.thankYouId,
    },
  ]);
  return true;
}

/** Claims due rows (skip-locked) so concurrent drains never send the same message twice. */
async function claim(db: Database, now: Date, limit: number): Promise<OutboundMessage[]> {
  const lockUntil = new Date(now.getTime() + 2 * 60_000);
  const res = await db.execute(sql`
    update outbound_messages set status = 'sending', locked_until = ${lockUntil.toISOString()}, attempts = attempts + 1
    where id in (
      select id from outbound_messages
      where (status = 'queued' and next_attempt_at <= ${now.toISOString()})
         or (status = 'sending' and locked_until < ${now.toISOString()})
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id`);
  const ids = (res.rows as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(outboundMessages).where(inArray(outboundMessages.id, ids));
}

async function sendOne(db: Database, row: OutboundMessage, now: Date) {
  await db.transaction(async (tx) => {
    if (row.eventId && OPT_OUTABLE.has(row.purpose) && (await isOptedOut(tx, row.eventId, row.channel, row.toAddress))) {
      await tx.update(outboundMessages).set({ status: "skipped_optout", lockedUntil: null }).where(eq(outboundMessages.id, row.id));
      await settle(tx, row, "released");
      return;
    }
    const provider = channelConnected(row.channel) ? providerFor(row.channel) : null;
    if (!provider) {
      await tx.update(outboundMessages).set({ status: "skipped_unavailable", lockedUntil: null }).where(eq(outboundMessages.id, row.id));
      await settle(tx, row, "released");
      await fallbackFrom(tx, row);
      return;
    }
    const fn = templates.get(row.templateKey);
    if (!fn) throw new Error(`No message template "${row.templateKey}"`);
    const locale: Locale = isLocale(row.locale) ? row.locale : "en";
    try {
      const msg = await fn(row.vars, locale, { db: tx, row });
      await provider.send(tx, { channel: row.channel, to: row.toAddress, subject: msg.subject, text: msg.text, idempotencyKey: row.idempotencyKey });
      await tx.update(outboundMessages).set({ status: "sent", sentAt: now, lockedUntil: null, errorCode: null }).where(eq(outboundMessages.id, row.id));
      await settle(tx, row, "sent");
    } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      if (row.attempts < MAX_ATTEMPTS) {
        await tx
          .update(outboundMessages)
          .set({ status: "queued", lockedUntil: null, errorCode: err.message.slice(0, 200), nextAttemptAt: new Date(now.getTime() + BACKOFF_MS[row.attempts - 1]) })
          .where(eq(outboundMessages.id, row.id));
      } else {
        await tx.update(outboundMessages).set({ status: "failed", lockedUntil: null, errorCode: err.message.slice(0, 200) }).where(eq(outboundMessages.id, row.id));
        await settle(tx, row, "released");
        await fallbackFrom(tx, row);
      }
    }
  });
}

/** Marks broadcasts done once nothing of theirs is waiting. */
async function finishBroadcasts(db: Database, ids: string[]) {
  if (ids.length === 0) return;
  const open = await db
    .selectDistinct({ id: outboundMessages.broadcastId })
    .from(outboundMessages)
    .where(and(inArray(outboundMessages.broadcastId, ids), or(eq(outboundMessages.status, "queued"), eq(outboundMessages.status, "sending"))));
  const done = ids.filter((id) => !open.some((o) => o.id === id));
  if (done.length)
    await db
      .update(broadcasts)
      .set({ status: "done", finishedAt: new Date() })
      .where(and(inArray(broadcasts.id, done), inArray(broadcasts.status, ["queued", "sending"])));
}

/**
 * Sends due messages until the time budget runs out. Returns counts and whether rows remain.
 */
export async function processOutbox(db: Database, opts: { budgetMs?: number; concurrency?: number; now?: () => Date } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 45_000;
  const conc = Math.max(1, opts.concurrency ?? 8);
  const clock = opts.now ?? (() => new Date());
  let processed = 0;
  const touched = new Set<string>();
  while (Date.now() - started < budget) {
    const batch = await claim(db, clock(), 50);
    if (batch.length === 0) break;
    for (let i = 0; i < batch.length; i += conc) {
      await Promise.all(
        batch.slice(i, i + conc).map(async (row) => {
          try {
            await sendOne(db, row, clock());
          } catch (err) {
            // Unexpected errors (e.g. a template bug) leave the row for retry after its lock expires.
            console.error("outbox send failed", row.id, err instanceof Error ? err.message : err);
          }
          if (row.broadcastId) touched.add(row.broadcastId);
          processed++;
        }),
      );
    }
  }
  await finishBroadcasts(db, [...touched]);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.status, "queued"), lt(outboundMessages.nextAttemptAt, clock())));
  return { processed, remaining: n };
}
