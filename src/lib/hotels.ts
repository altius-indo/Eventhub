import ExcelJS from "exceljs";
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  guests,
  guestTravel,
  hotels,
  households,
  roomAssignments,
  roomBlocks,
  rooms,
  rsvps,
  type Guest,
  type Hotel,
  type Household,
  type Room,
  type RoomBlock,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { normalizePhone } from "./guests";

export class HotelError extends Error {
  constructor(public code: "not_found" | "room_in_use" | "bad_dates" | "overlapping_stay" | "guest_not_found" | "phone_invalid") {
    super(code);
  }
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => v || null);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const hotelSchema = z.object({
  name: z.string().trim().min(1).max(160),
  address: text(400),
  phone: text(30),
  mapUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null)
    .refine((v) => !v || /^https?:\/\//i.test(v), "mapUrl"),
  notes: text(1000),
});
export type HotelInput = z.infer<typeof hotelSchema>;

export const blockSchema = z
  .object({
    roomType: z.string().trim().min(1).max(80),
    maxOccupancy: z.coerce.number().int().min(1).max(12),
    blockedCount: z.coerce.number().int().min(0).max(500),
    /** Rupees as typed (may have decimals); stored as paise. */
    rate: z
      .string()
      .trim()
      .optional()
      .transform((v, ctx) => {
        if (!v) return null;
        const n = Number(v.replace(/,/g, ""));
        if (!Number.isFinite(n) || n < 0) {
          ctx.addIssue({ code: "custom", message: "rate" });
          return null;
        }
        return Math.round(n * 100);
      }),
    checkIn: isoDate,
    checkOut: isoDate,
    notes: text(500),
  })
  .refine((v) => v.checkOut > v.checkIn, { message: "bad_dates", path: ["checkOut"] });
export type BlockInput = z.infer<typeof blockSchema>;

async function normalizeHotel(input: HotelInput): Promise<HotelInput> {
  if (!input.phone) return input;
  const p = normalizePhone(input.phone);
  if (p === "invalid") throw new HotelError("phone_invalid");
  return { ...input, phone: p };
}

export async function createHotel(db: Database, eventId: string, input: HotelInput) {
  const [h] = await db.insert(hotels).values({ eventId, ...(await normalizeHotel(input)) }).returning();
  return h;
}

export async function updateHotel(db: Database, eventId: string, hotelId: string, input: HotelInput) {
  const [h] = await db
    .update(hotels)
    .set({ ...(await normalizeHotel(input)), updatedAt: new Date() })
    .where(and(eq(hotels.id, hotelId), eq(hotels.eventId, eventId)))
    .returning();
  if (!h) throw new HotelError("not_found");
  return h;
}

export async function deleteHotel(db: Database, eventId: string, hotelId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(roomAssignments)
      .innerJoin(rooms, eq(rooms.id, roomAssignments.roomId))
      .innerJoin(roomBlocks, eq(roomBlocks.id, rooms.blockId))
      .where(eq(roomBlocks.hotelId, hotelId));
    const [h] = await tx
      .delete(hotels)
      .where(and(eq(hotels.id, hotelId), eq(hotels.eventId, eventId)))
      .returning();
    if (!h) throw new HotelError("not_found");
    await audit(tx, { eventId, actor, action: "hotel.deleted", entityType: "hotel", entityId: hotelId, data: { name: h.name, assigned: n } });
  });
}

export async function getHotel(db: Tx, eventId: string, hotelId: string) {
  const [h] = await db.select().from(hotels).where(and(eq(hotels.id, hotelId), eq(hotels.eventId, eventId)));
  if (!h) throw new HotelError("not_found");
  return h;
}

export async function listHotels(db: Tx, eventId: string) {
  return db
    .select({
      hotel: hotels,
      blocked: sql<number>`coalesce((select sum(${roomBlocks.blockedCount})::int from ${roomBlocks} where ${roomBlocks.hotelId} = ${hotels.id}), 0)`,
      roomsUsed: sql<number>`(select count(distinct ra.room_id)::int from ${roomAssignments} ra join ${rooms} r on r.id = ra.room_id join ${roomBlocks} b on b.id = r.block_id where b.hotel_id = ${hotels.id})`,
      guests: sql<number>`(select count(distinct ra.guest_id)::int from ${roomAssignments} ra join ${rooms} r on r.id = ra.room_id join ${roomBlocks} b on b.id = r.block_id where b.hotel_id = ${hotels.id})`,
    })
    .from(hotels)
    .where(eq(hotels.eventId, eventId))
    .orderBy(asc(hotels.name));
}

async function syncRooms(tx: Tx, eventId: string, block: RoomBlock, target: number) {
  const existing = await tx.select().from(rooms).where(eq(rooms.blockId, block.id)).orderBy(asc(rooms.sortOrder));
  if (target > existing.length) {
    const start = existing.length ? existing[existing.length - 1].sortOrder + 1 : 1;
    await tx.insert(rooms).values(Array.from({ length: target - existing.length }, (_, i) => ({ eventId, blockId: block.id, sortOrder: start + i })));
  } else if (target < existing.length) {
    const used = new Set(
      (
        await tx
          .selectDistinct({ id: roomAssignments.roomId })
          .from(roomAssignments)
          .where(
            inArray(
              roomAssignments.roomId,
              existing.map((r) => r.id),
            ),
          )
      ).map((r) => r.id),
    );
    const empty = existing.filter((r) => !used.has(r.id)).reverse();
    const toRemove = existing.length - target;
    if (empty.length < toRemove) throw new HotelError("room_in_use");
    await tx.delete(rooms).where(
      inArray(
        rooms.id,
        empty.slice(0, toRemove).map((r) => r.id),
      ),
    );
  }
}

export async function createBlock(db: Database, eventId: string, hotelId: string, input: BlockInput) {
  return db.transaction(async (tx) => {
    await getHotel(tx, eventId, hotelId);
    const { rate, ...rest } = input;
    const [block] = await tx.insert(roomBlocks).values({ eventId, hotelId, ...rest, ratePaise: rate }).returning();
    await syncRooms(tx, eventId, block, input.blockedCount);
    return block;
  });
}

/** Updates a block; raising the count adds rooms, lowering it removes only empty rooms. */
export async function updateBlock(db: Database, eventId: string, blockId: string, input: BlockInput, actor: Actor) {
  return db.transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(roomBlocks)
      .where(and(eq(roomBlocks.id, blockId), eq(roomBlocks.eventId, eventId)))
      .for("update");
    if (!old) throw new HotelError("not_found");
    const { rate, ...rest } = input;
    const [block] = await tx
      .update(roomBlocks)
      .set({ ...rest, ratePaise: rate, updatedAt: new Date() })
      .where(eq(roomBlocks.id, blockId))
      .returning();
    await syncRooms(tx, eventId, block, input.blockedCount);
    if (old.ratePaise !== rate) {
      await audit(tx, {
        eventId,
        actor,
        action: "room_block.rate_changed",
        entityType: "room_block",
        entityId: blockId,
        data: { roomType: block.roomType, from: old.ratePaise, to: rate },
      });
    }
    return block;
  });
}

export async function deleteBlock(db: Database, eventId: string, blockId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [b] = await tx
      .delete(roomBlocks)
      .where(and(eq(roomBlocks.id, blockId), eq(roomBlocks.eventId, eventId)))
      .returning();
    if (!b) throw new HotelError("not_found");
    await audit(tx, { eventId, actor, action: "room_block.deleted", entityType: "room_block", entityId: blockId, data: { roomType: b.roomType, rooms: b.blockedCount } });
  });
}

export async function renameRoom(db: Database, eventId: string, roomId: string, label: string) {
  const [r] = await db
    .update(rooms)
    .set({ label: label.trim().slice(0, 30) || null })
    .where(and(eq(rooms.id, roomId), eq(rooms.eventId, eventId)))
    .returning();
  if (!r) throw new HotelError("not_found");
}

export type AssignWarning = "over_occupancy" | "outside_block_dates" | "household_split";

/**
 * Puts guests in a room. Overlapping stays for the same guest are refused (one person,
 * one bed a night); occupancy beyond the room's maximum is only a warning (extra beds).
 */
export async function assignRoom(
  db: Database,
  eventId: string,
  roomId: string,
  guestIds: string[],
  dates?: { checkIn: string; checkOut: string },
): Promise<{ added: number; warnings: AssignWarning[] }> {
  const ids = [...new Set(guestIds)].sort();
  if (ids.length === 0) return { added: 0, warnings: [] };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ room: rooms, block: roomBlocks })
      .from(rooms)
      .innerJoin(roomBlocks, eq(roomBlocks.id, rooms.blockId))
      .where(and(eq(rooms.id, roomId), eq(rooms.eventId, eventId)));
    if (!row) throw new HotelError("not_found");
    // Same lock updateBlock takes, so shrinking a block can't delete this room mid-assignment.
    await tx.select({ id: roomBlocks.id }).from(roomBlocks).where(eq(roomBlocks.id, row.block.id)).for("update");
    const [stillThere] = await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId));
    if (!stillThere) throw new HotelError("not_found");
    const checkIn = dates?.checkIn ?? row.block.checkIn;
    const checkOut = dates?.checkOut ?? row.block.checkOut;
    if (!(checkOut > checkIn)) throw new HotelError("bad_dates");

    // Lock guests in a fixed order so concurrent assignments can't deadlock or double-book.
    const locked = await tx
      .select()
      .from(guests)
      .where(and(eq(guests.eventId, eventId), inArray(guests.id, ids)))
      .orderBy(asc(guests.id))
      .for("update");
    if (locked.length !== ids.length) throw new HotelError("guest_not_found");

    const overlapping = await tx
      .select({ guestId: roomAssignments.guestId })
      .from(roomAssignments)
      .where(
        and(
          inArray(roomAssignments.guestId, ids),
          ne(roomAssignments.roomId, roomId),
          lt(roomAssignments.checkIn, checkOut),
          gt(roomAssignments.checkOut, checkIn),
        ),
      );
    if (overlapping.length) throw new HotelError("overlapping_stay");

    const inserted = await tx
      .insert(roomAssignments)
      .values(ids.map((guestId) => ({ eventId, roomId, guestId, checkIn, checkOut })))
      .onConflictDoUpdate({ target: [roomAssignments.roomId, roomAssignments.guestId], set: { checkIn, checkOut } })
      .returning();

    const occupants = await tx
      .select({ guest: guests, checkIn: roomAssignments.checkIn, checkOut: roomAssignments.checkOut })
      .from(roomAssignments)
      .innerJoin(guests, eq(guests.id, roomAssignments.guestId))
      .where(eq(roomAssignments.roomId, roomId));
    const warnings: AssignWarning[] = [];
    if (peakOccupancy(occupants.map((o) => ({ ageGroup: o.guest.ageGroup, checkIn: o.checkIn, checkOut: o.checkOut }))) > row.block.maxOccupancy) {
      warnings.push("over_occupancy");
    }
    if (checkIn < row.block.checkIn || checkOut > row.block.checkOut) warnings.push("outside_block_dates");
    const households = new Set(locked.map((g) => g.householdId));
    const familyMembers = await tx
      .select({ id: guests.id })
      .from(guests)
      .where(inArray(guests.householdId, [...households]));
    const assignedAnywhere = new Set(
      (
        await tx
          .select({ id: roomAssignments.guestId })
          .from(roomAssignments)
          .where(
            inArray(
              roomAssignments.guestId,
              familyMembers.map((f) => f.id),
            ),
          )
      ).map((r) => r.id),
    );
    if (familyMembers.some((f) => !assignedAnywhere.has(f.id))) warnings.push("household_split");
    return { added: inserted.length, warnings };
  });
}

export async function unassignRoom(db: Database, eventId: string, roomId: string, guestId: string) {
  await db
    .delete(roomAssignments)
    .where(and(eq(roomAssignments.eventId, eventId), eq(roomAssignments.roomId, roomId), eq(roomAssignments.guestId, guestId)));
}

/** Most people (infants excluded) in a room on any single night, given their stays. */
export function peakOccupancy(stays: { ageGroup: string; checkIn: string; checkOut: string }[]): number {
  const counted = stays.filter((s) => s.ageGroup !== "infant");
  let peak = 0;
  for (const night of new Set(counted.map((s) => s.checkIn))) {
    peak = Math.max(peak, counted.filter((s) => s.checkIn <= night && night < s.checkOut).length);
  }
  return peak;
}

export type RoomView = Room & { occupants: (Guest & { checkIn: string; checkOut: string; householdName: string })[]; over: boolean };
export type BlockView = RoomBlock & { rooms: RoomView[] };

/** Blocks → rooms → occupants for one hotel, plus warnings per room. */
export async function allocationView(db: Tx, eventId: string, hotelId: string): Promise<BlockView[]> {
  const blocks = await db
    .select()
    .from(roomBlocks)
    .where(and(eq(roomBlocks.hotelId, hotelId), eq(roomBlocks.eventId, eventId)))
    .orderBy(asc(roomBlocks.roomType), asc(roomBlocks.createdAt));
  if (blocks.length === 0) return [];
  const roomRows = await db
    .select()
    .from(rooms)
    .where(
      inArray(
        rooms.blockId,
        blocks.map((b) => b.id),
      ),
    )
    .orderBy(asc(rooms.sortOrder));
  const occ = roomRows.length
    ? await db
        .select({ a: roomAssignments, guest: guests, householdName: households.name })
        .from(roomAssignments)
        .innerJoin(guests, eq(guests.id, roomAssignments.guestId))
        .innerJoin(households, eq(households.id, guests.householdId))
        .where(
          inArray(
            roomAssignments.roomId,
            roomRows.map((r) => r.id),
          ),
        )
        .orderBy(asc(households.name), asc(guests.sortOrder))
    : [];
  return blocks.map((b) => ({
    ...b,
    rooms: roomRows
      .filter((r) => r.blockId === b.id)
      .map((r) => {
        const occupants = occ.filter((o) => o.a.roomId === r.id).map((o) => ({ ...o.guest, checkIn: o.a.checkIn, checkOut: o.a.checkOut, householdName: o.householdName }));
        return { ...r, occupants, over: peakOccupancy(occupants) > b.maxOccupancy };
      }),
  }));
}

/**
 * Guests who probably need a room but have none: they shared travel details or
 * are attending something, and aren't assigned anywhere. Grouped by family.
 */
export async function unallocatedGuests(db: Tx, eventId: string) {
  return db
    .select({ guest: guests, household: households, hasTravel: sql<boolean>`${guestTravel.guestId} is not null` })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .leftJoin(guestTravel, eq(guestTravel.guestId, guests.id))
    .leftJoin(roomAssignments, eq(roomAssignments.guestId, guests.id))
    .where(
      and(
        eq(guests.eventId, eventId),
        isNull(roomAssignments.guestId),
        sql`(${guestTravel.guestId} is not null or exists (select 1 from ${rsvps} r where r.guest_id = ${guests.id} and r.status = 'attending'))`,
      ),
    )
    .orderBy(asc(households.name), asc(guests.sortOrder));
}

export type RoomingRow = { roomType: string; room: string; guestNames: string; checkIn: string; checkOut: string; nights: number; contactPhone: string };

/** Rooming list for a hotel (TRV-05): names, room, dates and one contact phone only. No ID data (§8). */
export async function roomingList(db: Tx, eventId: string, hotelId: string, roomWord: string): Promise<RoomingRow[]> {
  const view = await allocationView(db, eventId, hotelId);
  const householdIds = [...new Set(view.flatMap((b) => b.rooms.flatMap((r) => r.occupants.map((o) => o.householdId))))];
  const phones = householdIds.length
    ? await db
        .select({ householdId: guests.householdId, phone: guests.phone, isHead: guests.isHead })
        .from(guests)
        .where(and(inArray(guests.householdId, householdIds), sql`${guests.phone} is not null`))
    : [];
  const phoneFor = (occupants: RoomView["occupants"]) =>
    occupants.find((o) => o.phone)?.phone ??
    phones.filter((p) => occupants.some((o) => o.householdId === p.householdId)).sort((a, b) => Number(b.isHead) - Number(a.isHead))[0]?.phone ??
    "";
  const rows: RoomingRow[] = [];
  for (const b of view) {
    for (const r of b.rooms) {
      // One row per distinct stay in the room (different families on different nights stay separate).
      const stays = new Map<string, RoomView["occupants"]>();
      for (const o of r.occupants) stays.set(`${o.checkIn}|${o.checkOut}`, [...(stays.get(`${o.checkIn}|${o.checkOut}`) ?? []), o]);
      for (const [key, group] of [...stays.entries()].sort()) {
        const [checkIn, checkOut] = key.split("|");
        rows.push({
          roomType: b.roomType,
          room: r.label ?? `${roomWord} ${r.sortOrder}`,
          guestNames: group.map((o) => o.name).join(", "),
          checkIn,
          checkOut,
          nights: Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000),
          contactPhone: phoneFor(group),
        });
      }
    }
  }
  return rows;
}

export async function roomingListXlsx(hotel: Hotel, rows: RoomingRow[], headers: Record<keyof RoomingRow, string>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(hotel.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Rooming list");
  ws.columns = (Object.keys(headers) as (keyof RoomingRow)[]).map((k) => ({ header: headers[k], key: k, width: k === "guestNames" ? 40 : 16 }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A family's rooms for their own page: never shows other families' names. */
export async function roomsForHousehold(db: Tx, eventId: string, householdId: string) {
  const rows = await db
    .select({ a: roomAssignments, room: rooms, block: roomBlocks, hotel: hotels, guestName: guests.name })
    .from(roomAssignments)
    .innerJoin(guests, eq(guests.id, roomAssignments.guestId))
    .innerJoin(rooms, eq(rooms.id, roomAssignments.roomId))
    .innerJoin(roomBlocks, eq(roomBlocks.id, rooms.blockId))
    .innerJoin(hotels, eq(hotels.id, roomBlocks.hotelId))
    .where(and(eq(roomAssignments.eventId, eventId), eq(guests.householdId, householdId)))
    .orderBy(asc(roomAssignments.checkIn));
  const byRoom = new Map<string, { hotel: Hotel; roomType: string; label: string | null; checkIn: string; checkOut: string; names: string[] }>();
  for (const r of rows) {
    const e = byRoom.get(r.room.id) ?? { hotel: r.hotel, roomType: r.block.roomType, label: r.room.label, checkIn: r.a.checkIn, checkOut: r.a.checkOut, names: [] };
    e.names.push(r.guestName);
    if (r.a.checkIn < e.checkIn) e.checkIn = r.a.checkIn;
    if (r.a.checkOut > e.checkOut) e.checkOut = r.a.checkOut;
    byRoom.set(r.room.id, e);
  }
  return [...byRoom.values()];
}

export type { Household };
