import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import { functionInvites, functions, guests, mediaItems, type EventFunction } from "@/db/schema";
import { audit, type Actor } from "./audit";

export class NotFoundError extends Error {}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);
const optionalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal(""))
  .transform((v) => v || null);
const optionalTime = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v.slice(0, 5) : null));

export const functionSchema = z
  .object({
    name: z.string().trim().min(1, "nameRequired").max(120),
    date: optionalDate,
    startTime: optionalTime,
    endTime: optionalTime,
    venueName: optionalText(160),
    venueAddress: optionalText(400),
    mapUrl: z
      .string()
      .trim()
      .max(500)
      .optional()
      .or(z.literal(""))
      .transform((v) => v || null)
      .refine((v) => !v || /^https?:\/\//i.test(v), "mapUrl"),
    dressCode: optionalText(200),
    description: optionalText(2000),
    isPublic: z.boolean().optional(),
    venuePublic: z.boolean().optional(),
  })
  .refine((v) => !v.startTime || !v.endTime || v.endTime > v.startTime, { message: "timeOrder", path: ["endTime"] });

export type FunctionInput = z.infer<typeof functionSchema>;

export async function listFunctions(db: Tx, eventId: string): Promise<EventFunction[]> {
  return db
    .select()
    .from(functions)
    .where(eq(functions.eventId, eventId))
    .orderBy(sql`${functions.date} asc nulls last`, sql`${functions.startTime} asc nulls last`, asc(functions.createdAt));
}

export async function getFunction(db: Tx, eventId: string, functionId: string) {
  const [fn] = await db
    .select()
    .from(functions)
    .where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)));
  if (!fn) throw new NotFoundError();
  return fn;
}

export async function createFunction(db: Database, eventId: string, actor: Actor, input: FunctionInput) {
  return db.transaction(async (tx) => {
    const [fn] = await tx.insert(functions).values({ eventId, ...input }).returning();
    await audit(tx, { eventId, actor, action: "function.created", entityType: "function", entityId: fn.id, data: { name: fn.name } });
    return fn;
  });
}

export async function updateFunction(db: Database, eventId: string, functionId: string, actor: Actor, input: FunctionInput) {
  return db.transaction(async (tx) => {
    const [fn] = await tx
      .update(functions)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)))
      .returning();
    if (!fn) throw new NotFoundError();
    // A private function's photos can't stay on the public website (GAL-05).
    if (!fn.isPublic) {
      await tx
        .update(mediaItems)
        .set({ highlight: false })
        .where(and(eq(mediaItems.eventId, eventId), eq(mediaItems.functionId, fn.id), eq(mediaItems.highlight, true)));
    }
    await audit(tx, { eventId, actor, action: "function.updated", entityType: "function", entityId: fn.id, data: { name: fn.name } });
    return fn;
  });
}

export async function deleteFunction(db: Database, eventId: string, functionId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [fn] = await tx
      .delete(functions)
      .where(and(eq(functions.id, functionId), eq(functions.eventId, eventId)))
      .returning();
    if (!fn) throw new NotFoundError();
    await audit(tx, { eventId, actor, action: "function.deleted", entityType: "function", entityId: fn.id, data: { name: fn.name } });
  });
}

/** Throws unless every id is a function of this event. */
export async function assertFunctionsInEvent(db: Tx, eventId: string, functionIds: string[]) {
  const unique = [...new Set(functionIds)];
  if (unique.length === 0) return unique;
  const rows = await db
    .select({ id: functions.id })
    .from(functions)
    .where(and(eq(functions.eventId, eventId), inArray(functions.id, unique)));
  if (rows.length !== unique.length) throw new NotFoundError();
  return unique;
}

export type FunctionHeadcount = {
  guests: number;
  households: number;
  adults: number;
  children: number;
  infants: number;
};

/** Invited headcount per function (before RSVPs exist, this is the invited total). */
export async function invitedCounts(db: Tx, eventId: string): Promise<Map<string, FunctionHeadcount>> {
  const rows = await db
    .select({
      functionId: functionInvites.functionId,
      guests: sql<number>`count(*)::int`,
      households: sql<number>`count(distinct ${guests.householdId})::int`,
      adults: sql<number>`count(*) filter (where ${guests.ageGroup} = 'adult')::int`,
      children: sql<number>`count(*) filter (where ${guests.ageGroup} = 'child')::int`,
      infants: sql<number>`count(*) filter (where ${guests.ageGroup} = 'infant')::int`,
    })
    .from(functionInvites)
    .innerJoin(guests, eq(guests.id, functionInvites.guestId))
    .where(eq(guests.eventId, eventId))
    .groupBy(functionInvites.functionId);
  return new Map(rows.map(({ functionId, ...c }) => [functionId, c]));
}

/** Groups functions into days for the master schedule (ITN-02). Undated functions come last. */
export function groupByDay(fns: EventFunction[]): { date: string | null; functions: EventFunction[] }[] {
  const days: { date: string | null; functions: EventFunction[] }[] = [];
  for (const fn of fns) {
    const last = days[days.length - 1];
    if (last && last.date === fn.date) last.functions.push(fn);
    else days.push({ date: fn.date, functions: [fn] });
  }
  return days;
}

// ---------------------------------------------------------------------------
// Calendar export (ITN-06)
// ---------------------------------------------------------------------------

function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds lines longer than 75 octets as required by RFC 5545. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const ch of line) {
    if (Buffer.byteLength(current + ch, "utf8") > (parts.length === 0 ? 75 : 74)) {
      parts.push(current);
      current = "";
    }
    current += ch;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function addOneDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** An iCalendar file of an event's dated functions, in the event's timezone. */
export function functionsToIcs(
  event: { id: string; name: string; timezone: string },
  fns: EventFunction[],
  now = new Date(),
): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//EventHub//Schedule//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${icsEscape(event.name)}`,
    `X-WR-TIMEZONE:${event.timezone}`,
  ];
  for (const fn of fns) {
    if (!fn.date) continue;
    const day = fn.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${fn.id}@eventhub`, `DTSTAMP:${stamp}`);
    if (fn.startTime) {
      const start = fn.startTime.replace(/:/g, "").slice(0, 4) + "00";
      lines.push(`DTSTART;TZID=${event.timezone}:${day}T${start}`);
      if (fn.endTime) lines.push(`DTEND;TZID=${event.timezone}:${day}T${fn.endTime.replace(/:/g, "").slice(0, 4)}00`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${addOneDay(fn.date).replace(/-/g, "")}`);
    }
    lines.push(`SUMMARY:${icsEscape(`${fn.name} · ${event.name}`)}`);
    const location = [fn.venueName, fn.venueAddress].filter(Boolean).join(", ");
    if (location) lines.push(`LOCATION:${icsEscape(location)}`);
    const description = [fn.dressCode && `Dress code: ${fn.dressCode}`, fn.description, fn.mapUrl].filter(Boolean).join("\n");
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
    if (fn.mapUrl) lines.push(`URL:${fn.mapUrl}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
