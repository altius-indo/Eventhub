import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  diet as dietEnum,
  events,
  functionInvites,
  functions,
  guests,
  households,
  rsvps,
  rsvpStatus,
  type Event,
  type EventFunction,
  type Guest,
  type Household,
  type RsvpStatus,
} from "@/db/schema";
import { createTranslator, isLocale } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import { freezeDueLocks } from "./caterer-headcount";
import { DeliveryError, sendMessage } from "./delivery";
import { guestLinkUrl } from "./guest-links";
import { addDays, todayIn } from "./tasks";

export class RsvpError extends Error {
  constructor(public code: "closed" | "not_invited" | "no_allowance" | "not_found") {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Portal data
// ---------------------------------------------------------------------------

export type PortalMember = Guest & { functionIds: string[]; rsvp: Record<string, RsvpStatus> };
export type PortalData = {
  household: Household;
  members: PortalMember[];
  /** Functions at least one member is invited to, in schedule order. */
  functions: EventFunction[];
  plusOnesUsed: number;
};

export async function getPortalData(db: Tx, household: Household): Promise<PortalData> {
  const members = await db
    .select()
    .from(guests)
    .where(eq(guests.householdId, household.id))
    .orderBy(asc(guests.sortOrder), asc(guests.createdAt));
  const ids = members.map((m) => m.id);
  const [invites, answers] = ids.length
    ? await Promise.all([
        db.select().from(functionInvites).where(inArray(functionInvites.guestId, ids)),
        db.select().from(rsvps).where(inArray(rsvps.guestId, ids)),
      ])
    : [[], []];
  const fnIds = [...new Set(invites.map((i) => i.functionId))];
  const fns = fnIds.length
    ? await db
        .select()
        .from(functions)
        .where(inArray(functions.id, fnIds))
        .orderBy(sql`${functions.date} asc nulls last`, sql`${functions.startTime} asc nulls last`, asc(functions.createdAt))
    : [];
  return {
    household,
    functions: fns,
    plusOnesUsed: members.filter((m) => m.addedByGuest).length,
    members: members.map((m) => ({
      ...m,
      functionIds: invites.filter((i) => i.guestId === m.id).map((i) => i.functionId),
      rsvp: Object.fromEntries(answers.filter((a) => a.guestId === m.id).map((a) => [a.functionId, a.status])),
    })),
  };
}

/** Guests may change answers until the end of the deadline day in the event's timezone. */
export function rsvpOpen(event: Pick<Event, "rsvpDeadline" | "timezone">, now = new Date()): boolean {
  return !event.rsvpDeadline || todayIn(event.timezone, now) <= event.rsvpDeadline;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export const rsvpAnswerSchema = z.object({
  guestId: z.string().uuid(),
  functionId: z.string().uuid(),
  status: z.enum(rsvpStatus.enumValues).nullable(),
});
export const dietAnswerSchema = z.object({
  guestId: z.string().uuid(),
  diet: z.enum(dietEnum.enumValues).nullable(),
  dietNotes: z.string().trim().max(200).nullable(),
});

export type SaveRsvpInput = {
  household: Household;
  event: Pick<Event, "id" | "rsvpDeadline" | "timezone">;
  answers: z.infer<typeof rsvpAnswerSchema>[];
  diets?: z.infer<typeof dietAnswerSchema>[];
  /** The team member recording on the family's behalf (RSV-04); null when the guest answers. */
  recordedBy: Actor | null;
  now?: Date;
};

/**
 * Saves a family's answers. Guests are held to the deadline; Hosts/Planners are not.
 * Only invited (guest, function) pairs in this family are accepted. A null status clears an answer.
 */
export async function saveRsvps(db: Database, input: SaveRsvpInput) {
  const { household, event } = input;
  if (!input.recordedBy && !rsvpOpen(event, input.now)) throw new RsvpError("closed");
  return db.transaction(async (tx) => {
    const members = await tx.select({ id: guests.id }).from(guests).where(eq(guests.householdId, household.id));
    const memberIds = new Set(members.map((m) => m.id));
    const invites = members.length
      ? await tx
          .select()
          .from(functionInvites)
          .where(
            inArray(
              functionInvites.guestId,
              members.map((m) => m.id),
            ),
          )
      : [];
    const invited = new Set(invites.map((i) => `${i.guestId}:${i.functionId}`));
    for (const a of input.answers) {
      if (!memberIds.has(a.guestId) || !invited.has(`${a.guestId}:${a.functionId}`)) throw new RsvpError("not_invited");
    }
    // A caterer's final count locks at its guarantee time (RSV-07): freeze it before this change lands.
    await freezeDueLocks(tx, event.id, [...new Set(invites.map((i) => i.functionId))], input.now);
    let changed = 0;
    for (const a of input.answers) {
      if (a.status === null) {
        const del = await tx
          .delete(rsvps)
          .where(and(eq(rsvps.guestId, a.guestId), eq(rsvps.functionId, a.functionId)))
          .returning();
        changed += del.length;
        continue;
      }
      const res = await tx
        .insert(rsvps)
        .values({ guestId: a.guestId, functionId: a.functionId, status: a.status, recordedBy: input.recordedBy?.userId ?? null })
        .onConflictDoUpdate({
          target: [rsvps.functionId, rsvps.guestId],
          set: { status: a.status, recordedBy: input.recordedBy?.userId ?? null, respondedAt: new Date() },
          setWhere: sql`${rsvps.status} <> excluded.status`,
        })
        .returning();
      changed += res.length;
    }
    for (const d of input.diets ?? []) {
      if (!memberIds.has(d.guestId)) throw new RsvpError("not_found");
      await tx
        .update(guests)
        .set({ diet: d.diet, dietNotes: d.dietNotes || null, updatedAt: new Date() })
        .where(eq(guests.id, d.guestId));
    }
    if (changed > 0) {
      await audit(tx, {
        eventId: event.id,
        actor: input.recordedBy,
        action: input.recordedBy ? "rsvp.recorded" : "rsvp.guest_updated",
        entityType: "household",
        entityId: household.id,
        data: { name: household.name, changes: changed },
      });
    }
    return changed;
  });
}

/** A +1 (adult or child) added by the family, invited to the same functions as `invitedWithId`. */
export async function addPlusOne(
  db: Database,
  input: { household: Household; event: Pick<Event, "rsvpDeadline" | "timezone">; name: string; ageGroup: Guest["ageGroup"]; invitedWithId: string; byGuest: boolean },
) {
  if (input.byGuest && !rsvpOpen(input.event)) throw new RsvpError("closed");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new RsvpError("not_found");
  return db.transaction(async (tx) => {
    const [h] = await tx.select().from(households).where(eq(households.id, input.household.id)).for("update");
    const members = await tx.select().from(guests).where(eq(guests.householdId, h.id));
    if (members.filter((m) => m.addedByGuest).length >= h.plusOnesAllowed) throw new RsvpError("no_allowance");
    await freezeDueLocks(tx, h.eventId, null);
    const host = members.find((m) => m.id === input.invitedWithId);
    if (!host) throw new RsvpError("not_found");
    const [guest] = await tx
      .insert(guests)
      .values({ eventId: h.eventId, householdId: h.id, name, ageGroup: input.ageGroup, addedByGuest: true, sortOrder: members.length })
      .returning();
    const fnIds = (await tx.select().from(functionInvites).where(eq(functionInvites.guestId, host.id))).map((i) => i.functionId);
    if (fnIds.length) {
      await tx.insert(functionInvites).values(fnIds.map((functionId) => ({ functionId, guestId: guest.id })));
      // Someone adding a +1 is coming with them, so start with the same answers.
      const hostAnswers = await tx.select().from(rsvps).where(eq(rsvps.guestId, host.id));
      if (hostAnswers.length) {
        await tx.insert(rsvps).values(hostAnswers.map((a) => ({ functionId: a.functionId, guestId: guest.id, status: a.status })));
      }
    }
    return guest;
  });
}

export async function removePlusOne(db: Database, input: { household: Household; event: Pick<Event, "rsvpDeadline" | "timezone">; guestId: string; byGuest: boolean }) {
  if (input.byGuest && !rsvpOpen(input.event)) throw new RsvpError("closed");
  await db.transaction(async (tx) => {
    await freezeDueLocks(tx, input.household.eventId, null);
    const res = await tx
      .delete(guests)
      .where(and(eq(guests.id, input.guestId), eq(guests.householdId, input.household.id), eq(guests.addedByGuest, true)))
      .returning();
    if (res.length === 0) throw new RsvpError("not_found");
  });
}

// ---------------------------------------------------------------------------
// Headcounts (RSV-05)
// ---------------------------------------------------------------------------

export type Headcount = {
  invited: number;
  attending: number;
  maybe: number;
  declined: number;
  pending: number;
  households: { invited: number; responded: number };
  attendingBy: {
    side: { bride: number; groom: number; both: number };
    age: { adult: number; child: number; infant: number };
    diet: { veg: number; non_veg: number; jain: number; vegan: number; other: number; unknown: number };
    allergies: number;
  };
};

export async function headcounts(db: Tx, eventId: string): Promise<Map<string, Headcount>> {
  const rows = await db
    .select({
      functionId: functionInvites.functionId,
      householdId: guests.householdId,
      side: households.side,
      ageGroup: guests.ageGroup,
      diet: guests.diet,
      dietNotes: guests.dietNotes,
      status: rsvps.status,
    })
    .from(functionInvites)
    .innerJoin(guests, eq(guests.id, functionInvites.guestId))
    .innerJoin(households, eq(households.id, guests.householdId))
    .leftJoin(rsvps, and(eq(rsvps.guestId, functionInvites.guestId), eq(rsvps.functionId, functionInvites.functionId)))
    .where(eq(guests.eventId, eventId));

  const out = new Map<string, Headcount>();
  const hh = new Map<string, { invited: Set<string>; responded: Set<string> }>();
  for (const r of rows) {
    let c = out.get(r.functionId);
    if (!c) {
      c = {
        invited: 0,
        attending: 0,
        maybe: 0,
        declined: 0,
        pending: 0,
        households: { invited: 0, responded: 0 },
        attendingBy: {
          side: { bride: 0, groom: 0, both: 0 },
          age: { adult: 0, child: 0, infant: 0 },
          diet: { veg: 0, non_veg: 0, jain: 0, vegan: 0, other: 0, unknown: 0 },
          allergies: 0,
        },
      };
      out.set(r.functionId, c);
      hh.set(r.functionId, { invited: new Set(), responded: new Set() });
    }
    const h = hh.get(r.functionId)!;
    c.invited++;
    h.invited.add(r.householdId);
    if (!r.status) {
      c.pending++;
      continue;
    }
    h.responded.add(r.householdId);
    c[r.status]++;
    if (r.status === "attending") {
      c.attendingBy.side[r.side]++;
      c.attendingBy.age[r.ageGroup]++;
      c.attendingBy.diet[r.diet ?? "unknown"]++;
      if (r.dietNotes) c.attendingBy.allergies++;
    }
  }
  for (const [fnId, c] of out) {
    const h = hh.get(fnId)!;
    c.households = { invited: h.invited.size, responded: h.responded.size };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reminders to families who haven't answered (RSV-03). Run daily.
// ---------------------------------------------------------------------------

export const RSVP_REMINDER_WINDOW_DAYS = 14;
export const RSVP_REMINDER_INTERVAL_DAYS = 3;

export async function sendRsvpReminders(db: Database, appUrl: string, now = new Date()) {
  // Families with at least one invited member who hasn't answered, in events whose deadline is near.
  const candidates = await db
    .select({ household: households, event: events })
    .from(households)
    .innerJoin(events, eq(events.id, households.eventId))
    .where(
      and(
        isNull(events.deletedAt),
        isNull(households.linkRevokedAt),
        sql`${events.rsvpDeadline} is not null`,
        sql`exists (
          select 1 from ${functionInvites} fi join ${guests} g on g.id = fi.guest_id
          left join ${rsvps} r on r.guest_id = fi.guest_id and r.function_id = fi.function_id
          where g.household_id = ${households.id} and r.status is null)`,
        or(isNull(households.rsvpRemindedAt), lte(households.rsvpRemindedAt, new Date(now.getTime() - RSVP_REMINDER_INTERVAL_DAYS * 86_400_000))),
      ),
    );

  let sent = 0;
  for (const { household, event } of candidates) {
    const today = todayIn(event.timezone, now);
    if (!event.rsvpDeadline || event.rsvpDeadline < today || event.rsvpDeadline > addDays(today, RSVP_REMINDER_WINDOW_DAYS)) continue;
    const members = await db
      .select()
      .from(guests)
      .where(and(eq(guests.householdId, household.id), or(gt(sql`length(coalesce(${guests.phone}, ''))`, 0), gt(sql`length(coalesce(${guests.email}, ''))`, 0))))
      .orderBy(sql`${guests.isHead} desc`, asc(guests.sortOrder));
    const contact = members[0];
    if (!contact) continue;
    const t = createTranslator(isLocale(household.locale) ? household.locale : "en");
    const text = t("rsvp.reminderMessage", { family: household.name, event: event.name, date: event.rsvpDeadline, url: guestLinkUrl(appUrl, household) });
    try {
      await sendMessage(db, {
        channel: contact.phone ? "sms" : "email",
        to: (contact.phone ?? contact.email)!,
        subject: event.name,
        text,
      });
    } catch (err) {
      if (err instanceof DeliveryError) {
        console.error("RSVP reminder failed", err);
        continue;
      }
      throw err;
    }
    await db.update(households).set({ rsvpRemindedAt: now }).where(eq(households.id, household.id));
    sent++;
  }
  return sent;
}
