import { and, asc, count, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  ageGroup as ageGroupEnum,
  diet as dietEnum,
  functionInvites,
  guests,
  households,
  savedViews,
  side as sideEnum,
  type Guest,
  type Household,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { freezeDueLocks } from "./caterer-headcount";
import { anonymiseGiftsOfHousehold } from "./gifts";
import { releaseHouseholdMedia } from "./gallery";
import { assertFunctionsInEvent, NotFoundError } from "./functions";
import { isUuid } from "./ids";
import { householdPrefix } from "./storage";
import { queueStorageDeletion } from "./storage-gc";

export class GuestError extends Error {
  constructor(public code: "last_member" | "not_found") {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers (shared with the spreadsheet import)
// ---------------------------------------------------------------------------

/** E.164 phone, null when empty, or "invalid". Indian numbers don't need +91. */
export function normalizePhone(raw: string | null | undefined): string | null | "invalid" {
  const input = (raw ?? "").trim();
  if (!input) return null;
  const phone = parsePhoneNumberFromString(input, "IN");
  return phone && phone.isValid() ? phone.number : "invalid";
}

/** "+919876543210" → "+91 98765 43210" for display. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}

export function normalizeEmail(raw: string | null | undefined): string | null | "invalid" {
  const input = (raw ?? "").trim().toLowerCase();
  if (!input) return null;
  return z.email().safeParse(input).success ? input : "invalid";
}

/** Splits "VIP, elders; college friends" into unique tags, keeping the first spelling. */
export function normalizeTags(raw: string | string[] | null | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : (raw ?? "").split(/[,;\n]/)).map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of parts) {
    const key = tag.toLowerCase();
    if (!seen.has(key) && tag.length <= 40) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out.slice(0, 20);
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);

export const householdSchema = z.object({
  name: z.string().trim().min(1, "nameRequired").max(120),
  side: z.enum(sideEnum.enumValues).default("both"),
  address: text(400),
  city: text(80),
  postalCode: text(20),
  notes: text(2000),
});
export type HouseholdInput = z.infer<typeof householdSchema>;

export const guestSchema = z
  .object({
    name: z.string().trim().min(1, "nameRequired").max(120),
    relation: text(80),
    ageGroup: z.enum(ageGroupEnum.enumValues).default("adult"),
    phone: z.string().optional(),
    email: z.string().optional(),
    diet: z
      .enum(dietEnum.enumValues)
      .optional()
      .or(z.literal(""))
      .transform((v) => v || null),
    dietNotes: text(200),
    accessibilityNotes: text(500),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .transform((v, ctx) => {
    const phone = normalizePhone(v.phone);
    const email = normalizeEmail(v.email);
    if (phone === "invalid") ctx.addIssue({ code: "custom", message: "phoneInvalid", path: ["phone"] });
    if (email === "invalid") ctx.addIssue({ code: "custom", message: "emailInvalid", path: ["email"] });
    return {
      ...v,
      phone: phone === "invalid" ? null : phone,
      email: email === "invalid" ? null : email,
      tags: normalizeTags(v.tags),
    };
  });
export type GuestInput = z.output<typeof guestSchema>;

// ---------------------------------------------------------------------------
// Households & members
// ---------------------------------------------------------------------------

async function getHousehold(db: Tx, eventId: string, householdId: string): Promise<Household> {
  const [h] = await db
    .select()
    .from(households)
    .where(and(eq(households.id, householdId), eq(households.eventId, eventId)));
  if (!h) throw new GuestError("not_found");
  return h;
}

async function getGuest(db: Tx, eventId: string, guestId: string): Promise<Guest> {
  const [g] = await db
    .select()
    .from(guests)
    .where(and(eq(guests.id, guestId), eq(guests.eventId, eventId)));
  if (!g) throw new GuestError("not_found");
  return g;
}

async function inviteGuests(tx: Tx, guestIds: string[], functionIds: string[]) {
  const values = guestIds.flatMap((guestId) => functionIds.map((functionId) => ({ guestId, functionId })));
  if (values.length) await tx.insert(functionInvites).values(values).onConflictDoNothing();
}

/** Creates a household with its members; every member is invited to `functionIds` (GST-03). */
export async function createHousehold(
  db: Database,
  eventId: string,
  actor: Actor,
  input: { household: HouseholdInput; members: GuestInput[]; functionIds?: string[] },
) {
  if (input.members.length === 0) throw new GuestError("last_member");
  return db.transaction(async (tx) => {
    const functionIds = await assertFunctionsInEvent(tx, eventId, input.functionIds ?? []);
    await freezeDueLocks(tx, eventId, functionIds);
    const [household] = await tx.insert(households).values({ eventId, ...input.household }).returning();
    const members = await tx
      .insert(guests)
      .values(input.members.map((m, i) => ({ ...m, eventId, householdId: household.id, isHead: i === 0, sortOrder: i })))
      .returning();
    await inviteGuests(
      tx,
      members.map((m) => m.id),
      functionIds,
    );
    await audit(tx, {
      eventId,
      actor,
      action: "household.created",
      entityType: "household",
      entityId: household.id,
      data: { name: household.name, members: members.length },
    });
    return { household, members };
  });
}

export async function updateHousehold(db: Database, eventId: string, householdId: string, input: HouseholdInput) {
  return db.transaction(async (tx) => {
    // The side feeds the headcount: a due caterer lock freezes before this change (RSV-07).
    await freezeDueLocks(tx, eventId, null);
    const [h] = await tx
      .update(households)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(households.id, householdId), eq(households.eventId, eventId)))
      .returning();
    if (!h) throw new GuestError("not_found");
    return h;
  });
}

export async function deleteHousehold(db: Database, eventId: string, householdId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    // Erasure (EVT-09): their gifts stay for reconciliation, without the name or link.
    await anonymiseGiftsOfHousehold(tx, eventId, householdId);
    await freezeDueLocks(tx, eventId, null);
    // Their gallery uploads stop counting against the event's storage now (LIM-01).
    await releaseHouseholdMedia(tx, eventId, householdId);
    const [h] = await tx
      .delete(households)
      .where(and(eq(households.id, householdId), eq(households.eventId, eventId)))
      .returning();
    if (!h) throw new GuestError("not_found");
    // Their uploads (gallery, WP-B) live under the household's prefix (ADR-0030).
    await queueStorageDeletion(tx, householdPrefix(eventId, h.id), "household_deleted");
    await audit(tx, { eventId, actor, action: "household.deleted", entityType: "household", entityId: h.id, data: { name: h.name } });
  });
}

/** Adds a member; they're invited to the same functions as the head of the household. */
export async function addGuest(db: Database, eventId: string, householdId: string, input: GuestInput) {
  return db.transaction(async (tx) => {
    await getHousehold(tx, eventId, householdId);
    await freezeDueLocks(tx, eventId, null);
    const [{ n }] = await tx.select({ n: count() }).from(guests).where(eq(guests.householdId, householdId));
    const [guest] = await tx
      .insert(guests)
      .values({ ...input, eventId, householdId, isHead: n === 0, sortOrder: n })
      .returning();
    const [head] = await tx
      .select({ id: guests.id })
      .from(guests)
      .where(and(eq(guests.householdId, householdId), eq(guests.isHead, true)));
    if (head && head.id !== guest.id) {
      const headInvites = await tx.select({ functionId: functionInvites.functionId }).from(functionInvites).where(eq(functionInvites.guestId, head.id));
      await inviteGuests(
        tx,
        [guest.id],
        headInvites.map((i) => i.functionId),
      );
    }
    return guest;
  });
}

export async function updateGuest(db: Database, eventId: string, guestId: string, input: GuestInput) {
  return db.transaction(async (tx) => {
    // Age group and diet feed the headcount: a due caterer lock freezes first (RSV-07).
    await freezeDueLocks(tx, eventId, null);
    const [g] = await tx
      .update(guests)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(guests.id, guestId), eq(guests.eventId, eventId)))
      .returning();
    if (!g) throw new GuestError("not_found");
    return g;
  });
}

/** Removes a member. The last member can't be removed; delete the household instead. */
export async function removeGuest(db: Database, eventId: string, guestId: string) {
  await db.transaction(async (tx) => {
    const guest = await getGuest(tx, eventId, guestId);
    await tx.select({ id: households.id }).from(households).where(eq(households.id, guest.householdId)).for("update");
    const [{ n }] = await tx.select({ n: count() }).from(guests).where(eq(guests.householdId, guest.householdId));
    if (n <= 1) throw new GuestError("last_member");
    await freezeDueLocks(tx, eventId, null);
    await tx.delete(guests).where(eq(guests.id, guestId));
    if (guest.isHead) {
      const [next] = await tx
        .select({ id: guests.id })
        .from(guests)
        .where(eq(guests.householdId, guest.householdId))
        .orderBy(asc(guests.sortOrder), asc(guests.createdAt))
        .limit(1);
      await tx.update(guests).set({ isHead: true }).where(eq(guests.id, next.id));
    }
  });
}

export async function setHead(db: Database, eventId: string, guestId: string) {
  await db.transaction(async (tx) => {
    const guest = await getGuest(tx, eventId, guestId);
    await tx.update(guests).set({ isHead: false }).where(eq(guests.householdId, guest.householdId));
    await tx.update(guests).set({ isHead: true }).where(eq(guests.id, guestId));
  });
}

/** Replaces one guest's invitations (member-level). */
export async function setGuestInvites(db: Database, eventId: string, guestId: string, functionIds: string[]) {
  await db.transaction(async (tx) => {
    await getGuest(tx, eventId, guestId);
    const ids = await assertFunctionsInEvent(tx, eventId, functionIds);
    await freezeDueLocks(tx, eventId, null);
    await tx.delete(functionInvites).where(eq(functionInvites.guestId, guestId));
    await inviteGuests(tx, [guestId], ids);
  });
}

/** Sets invitations for a whole household from a member × function matrix. */
export async function setHouseholdInvites(
  db: Database,
  eventId: string,
  householdId: string,
  invites: Record<string, string[]>,
) {
  await db.transaction(async (tx) => {
    await getHousehold(tx, eventId, householdId);
    const members = await tx.select({ id: guests.id }).from(guests).where(eq(guests.householdId, householdId));
    const memberIds = new Set(members.map((m) => m.id));
    const all = await assertFunctionsInEvent(tx, eventId, Object.values(invites).flat());
    const allowed = new Set(all);
    await freezeDueLocks(tx, eventId, null);
    if (memberIds.size) await tx.delete(functionInvites).where(inArray(functionInvites.guestId, [...memberIds]));
    for (const [guestId, fnIds] of Object.entries(invites)) {
      if (!memberIds.has(guestId)) throw new GuestError("not_found");
      await inviteGuests(
        tx,
        [guestId],
        fnIds.filter((f) => allowed.has(f)),
      );
    }
  });
}

/** Adds or removes one function for many guests at once (bulk action on the guest list). */
export async function bulkInvite(db: Database, eventId: string, guestIds: string[], functionId: string, invite: boolean) {
  await db.transaction(async (tx) => {
    await assertFunctionsInEvent(tx, eventId, [functionId]);
    const owned = guestIds.length
      ? await tx
          .select({ id: guests.id })
          .from(guests)
          .where(and(eq(guests.eventId, eventId), inArray(guests.id, guestIds)))
      : [];
    const ids = owned.map((g) => g.id);
    if (ids.length === 0) return;
    await freezeDueLocks(tx, eventId, [functionId]);
    if (invite) await inviteGuests(tx, ids, [functionId]);
    else await tx.delete(functionInvites).where(and(eq(functionInvites.functionId, functionId), inArray(functionInvites.guestId, ids)));
  });
}

// ---------------------------------------------------------------------------
// Listing, filtering and stats (GST-05)
// ---------------------------------------------------------------------------

export const guestFilterKeys = ["q", "side", "tag", "fn", "age", "diet", "rsvp", "travel"] as const;
export type GuestFilters = Partial<Record<(typeof guestFilterKeys)[number], string>>;

export function cleanFilters(input: Record<string, unknown>): GuestFilters {
  const out: GuestFilters = {};
  for (const key of guestFilterKeys) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim().slice(0, 100);
  }
  return out;
}

function guestConditions(eventId: string, f: GuestFilters): SQL[] {
  const conds: SQL[] = [eq(guests.eventId, eventId)];
  if (f.q) {
    // A phone typed with spaces ("98765 43210") is one term; otherwise every word must match
    // the guest's name, family, email or phone, in any order ("Sharma Rajesh").
    const digitsOnly = /^[\d\s+()-]+$/.test(f.q);
    const terms = digitsOnly ? [f.q] : f.q.split(/\s+/).filter(Boolean).slice(0, 5);
    for (const term of terms) {
      const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      const phoneDigits = term.replace(/\D/g, "");
      conds.push(
        or(
          ilike(guests.name, pattern),
          ilike(households.name, pattern),
          ilike(guests.email, pattern),
          phoneDigits.length >= 4 ? ilike(guests.phone, `%${phoneDigits}%`) : undefined,
        )!,
      );
    }
  }
  if (f.side && (sideEnum.enumValues as readonly string[]).includes(f.side)) conds.push(eq(households.side, f.side as Household["side"]));
  if (f.age && (ageGroupEnum.enumValues as readonly string[]).includes(f.age)) conds.push(eq(guests.ageGroup, f.age as Guest["ageGroup"]));
  if (f.diet === "unknown") conds.push(isNull(guests.diet));
  else if (f.diet && (dietEnum.enumValues as readonly string[]).includes(f.diet)) conds.push(eq(guests.diet, f.diet as NonNullable<Guest["diet"]>));
  if (f.tag) conds.push(sql`lower(${f.tag}) = any (select lower(t) from unnest(${guests.tags}) t)`);
  if (f.fn === "none") {
    conds.push(sql`not exists (select 1 from ${functionInvites} where ${functionInvites.guestId} = ${guests.id})`);
  } else if (f.fn && isUuid(f.fn)) {
    conds.push(
      sql`exists (select 1 from ${functionInvites} where ${functionInvites.guestId} = ${guests.id} and ${functionInvites.functionId} = ${f.fn})`,
    );
  }
  // RSVP status, for one function when `fn` is set, otherwise for any function
  const fnId = f.fn && isUuid(f.fn) ? f.fn : null;
  const fnClause = fnId ? sql`and fi.function_id = ${fnId}` : sql``;
  if (f.rsvp === "pending") {
    conds.push(sql`exists (select 1 from function_invites fi left join rsvps r on r.guest_id = fi.guest_id and r.function_id = fi.function_id
      where fi.guest_id = ${guests.id} and r.status is null ${fnClause})`);
  } else if (f.rsvp === "attending" || f.rsvp === "maybe" || f.rsvp === "declined") {
    conds.push(sql`exists (select 1 from function_invites fi join rsvps r on r.guest_id = fi.guest_id and r.function_id = fi.function_id
      where fi.guest_id = ${guests.id} and r.status = ${f.rsvp} ${fnClause})`);
  }
  if (f.travel === "submitted") conds.push(sql`exists (select 1 from guest_travel t where t.guest_id = ${guests.id} and (t.arrival_at is not null or t.arrival_mode is not null))`);
  else if (f.travel === "missing") conds.push(sql`not exists (select 1 from guest_travel t where t.guest_id = ${guests.id} and (t.arrival_at is not null or t.arrival_mode is not null))`);
  else if (f.travel === "pickup") conds.push(sql`exists (select 1 from guest_travel t where t.guest_id = ${guests.id} and (t.needs_pickup or t.needs_drop))`);
  return conds;
}

export type HouseholdWithMembers = Household & { members: (Guest & { functionIds: string[] })[] };

export const HOUSEHOLDS_PER_PAGE = 50;

/**
 * Guests matching the filters, grouped by household. Pagination is by
 * household so a family is never split across pages.
 */
export async function listGuests(db: Tx, eventId: string, filters: GuestFilters, page = 1) {
  const conds = and(...guestConditions(eventId, filters));
  const householdIdsQuery = db
    .selectDistinct({ id: households.id, name: households.name })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(conds)
    .orderBy(asc(households.name), asc(households.id));

  // Independent queries run in parallel (§4: 1,000 guests filter in < 300 ms p95; tests/perf.test.ts).
  const [[{ total, matching }], pageRows] = await Promise.all([
    db
      .select({ total: sql<number>`count(distinct ${households.id})::int`, matching: sql<number>`count(*)::int` })
      .from(guests)
      .innerJoin(households, eq(households.id, guests.householdId))
      .where(conds),
    householdIdsQuery.limit(HOUSEHOLDS_PER_PAGE).offset((Math.max(1, page) - 1) * HOUSEHOLDS_PER_PAGE),
  ]);
  const ids = pageRows.map((r) => r.id);
  if (ids.length === 0) return { households: [] as HouseholdWithMembers[], totalHouseholds: total, matchingGuests: matching };

  const pageConds = and(conds, inArray(households.id, ids));
  const [rows, invites] = await Promise.all([
    db
      .select({ guest: guests, household: households })
      .from(guests)
      .innerJoin(households, eq(households.id, guests.householdId))
      .where(pageConds)
      .orderBy(asc(households.name), asc(households.id), asc(guests.sortOrder), asc(guests.createdAt)),
    db
      .select({ guestId: functionInvites.guestId, functionId: functionInvites.functionId })
      .from(functionInvites)
      .innerJoin(guests, eq(guests.id, functionInvites.guestId))
      .where(and(eq(guests.eventId, eventId), inArray(guests.householdId, ids))),
  ]);

  const fnsByGuest = groupInvites(invites);
  const byId = new Map<string, HouseholdWithMembers>();
  for (const { guest, household } of rows) {
    let h = byId.get(household.id);
    if (!h) {
      h = { ...household, members: [] };
      byId.set(household.id, h);
    }
    h.members.push({ ...guest, functionIds: fnsByGuest.get(guest.id) ?? [] });
  }
  return { households: [...byId.values()], totalHouseholds: total, matchingGuests: matching };
}

/** guest id -> invited function ids, in one pass (avoids an O(guests × invites) filter). */
function groupInvites(invites: { guestId: string; functionId: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const i of invites) {
    const list = out.get(i.guestId);
    if (list) list.push(i.functionId);
    else out.set(i.guestId, [i.functionId]);
  }
  return out;
}

/** Every guest matching the filters (for export and bulk actions). */
export async function listAllGuests(db: Tx, eventId: string, filters: GuestFilters = {}) {
  // Invites for the whole event in parallel (one indexed scan) rather than a 1,000-id IN list.
  const [rows, invites] = await Promise.all([
    db
      .select({ guest: guests, household: households })
      .from(guests)
      .innerJoin(households, eq(households.id, guests.householdId))
      .where(and(...guestConditions(eventId, filters)))
      .orderBy(asc(households.name), asc(households.id), asc(guests.sortOrder), asc(guests.createdAt)),
    db
      .select({ guestId: functionInvites.guestId, functionId: functionInvites.functionId })
      .from(functionInvites)
      .innerJoin(guests, eq(guests.id, functionInvites.guestId))
      .where(eq(guests.eventId, eventId)),
  ]);
  const fnsByGuest = groupInvites(invites);
  return rows.map((r) => ({ ...r, functionIds: fnsByGuest.get(r.guest.id) ?? [] }));
}

export async function getHouseholdWithMembers(db: Tx, eventId: string, householdId: string): Promise<HouseholdWithMembers> {
  const household = await getHousehold(db, eventId, householdId);
  const members = await db
    .select()
    .from(guests)
    .where(eq(guests.householdId, householdId))
    .orderBy(asc(guests.sortOrder), asc(guests.createdAt));
  const invites = members.length
    ? await db
        .select()
        .from(functionInvites)
        .where(
          inArray(
            functionInvites.guestId,
            members.map((m) => m.id),
          ),
        )
    : [];
  const fnsByGuest = groupInvites(invites);
  return { ...household, members: members.map((m) => ({ ...m, functionIds: fnsByGuest.get(m.id) ?? [] })) };
}

export async function guestStats(db: Tx, eventId: string) {
  const [row] = await db
    .select({
      households: sql<number>`count(distinct ${guests.householdId})::int`,
      guests: sql<number>`count(*)::int`,
      bride: sql<number>`count(*) filter (where ${households.side} = 'bride')::int`,
      groom: sql<number>`count(*) filter (where ${households.side} = 'groom')::int`,
      both: sql<number>`count(*) filter (where ${households.side} = 'both')::int`,
      adults: sql<number>`count(*) filter (where ${guests.ageGroup} = 'adult')::int`,
      children: sql<number>`count(*) filter (where ${guests.ageGroup} = 'child')::int`,
      infants: sql<number>`count(*) filter (where ${guests.ageGroup} = 'infant')::int`,
      uninvited: sql<number>`count(*) filter (where not exists (select 1 from ${functionInvites} where ${functionInvites.guestId} = ${guests.id}))::int`,
    })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(eq(guests.eventId, eventId));
  return row;
}

export async function listTags(db: Tx, eventId: string): Promise<string[]> {
  const rows = await db.execute<{ tag: string }>(
    sql`select min(t) as tag from ${guests}, unnest(${guests.tags}) t where ${guests.eventId} = ${eventId} group by lower(t) order by lower(t)`,
  );
  return rows.rows.map((r) => r.tag);
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

export async function listSavedViews(db: Tx, eventId: string) {
  return db.select().from(savedViews).where(eq(savedViews.eventId, eventId)).orderBy(asc(savedViews.name));
}

export async function saveView(db: Tx, eventId: string, userId: string, name: string, filters: GuestFilters) {
  const [view] = await db
    .insert(savedViews)
    .values({ eventId, name: name.trim().slice(0, 60), filters, createdBy: userId })
    .returning();
  return view;
}

export async function deleteSavedView(db: Tx, eventId: string, viewId: string) {
  await db.delete(savedViews).where(and(eq(savedViews.id, viewId), eq(savedViews.eventId, eventId)));
}

export { NotFoundError };
