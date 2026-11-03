import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { guestTravel, travelMode, type GuestTravel } from "@/db/schema";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);
/** "2026-12-09T14:30" from <input type="datetime-local">, interpreted as local event time. */
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? new Date(`${v}:00Z`) : null));
const mode = z
  .enum(travelMode.enumValues)
  .optional()
  .or(z.literal(""))
  .transform((v) => v || null);

export const travelSchema = z
  .object({
    arrivalMode: mode,
    arrivalNumber: optText(40),
    arrivalAt: localDateTime,
    arrivalPoint: optText(120),
    needsPickup: z.boolean().default(false),
    departureMode: mode,
    departureNumber: optText(40),
    departureAt: localDateTime,
    departurePoint: optText(120),
    needsDrop: z.boolean().default(false),
    notes: optText(500),
  })
  .refine((v) => !v.arrivalAt || !v.departureAt || v.departureAt > v.arrivalAt, { message: "order", path: ["departureAt"] });
export type TravelInput = z.infer<typeof travelSchema>;

/** Travel times are stored as "wall clock" times in the event's timezone (no conversion). */
export function toLocalInput(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 16) : "";
}

export function travelFromForm(formData: FormData, prefix = "") {
  const g = (k: string) => String(formData.get(`${prefix}${k}`) ?? "");
  return travelSchema.safeParse({
    arrivalMode: g("arrivalMode"),
    arrivalNumber: g("arrivalNumber"),
    arrivalAt: g("arrivalAt"),
    arrivalPoint: g("arrivalPoint"),
    needsPickup: formData.get(`${prefix}needsPickup`) === "on",
    departureMode: g("departureMode"),
    departureNumber: g("departureNumber"),
    departureAt: g("departureAt"),
    departurePoint: g("departurePoint"),
    needsDrop: formData.get(`${prefix}needsDrop`) === "on",
    notes: g("notes"),
  });
}

export async function saveTravel(db: Tx, guestId: string, input: TravelInput, byGuest: boolean) {
  await db
    .insert(guestTravel)
    .values({ guestId, ...input, updatedByGuest: byGuest })
    .onConflictDoUpdate({ target: guestTravel.guestId, set: { ...input, updatedByGuest: byGuest, updatedAt: new Date() } });
}

export async function travelFor(db: Tx, guestIds: string[]): Promise<Map<string, GuestTravel>> {
  if (guestIds.length === 0) return new Map();
  const rows = await db.select().from(guestTravel).where(inArray(guestTravel.guestId, guestIds));
  return new Map(rows.map((r) => [r.guestId, r]));
}

export async function clearTravel(db: Tx, guestId: string) {
  await db.delete(guestTravel).where(eq(guestTravel.guestId, guestId));
}

export function hasTravel(t: GuestTravel | undefined): boolean {
  return !!t && !!(t.arrivalAt || t.arrivalMode || t.departureAt || t.departureMode);
}
