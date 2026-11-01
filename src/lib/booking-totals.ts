import { and, asc, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { bookings, fulfilments, paymentMilestones } from "@/db/schema";
import { allocate } from "./money";

/**
 * After fulfilments are cancelled (a requirement or service was cancelled), a booking's amount
 * follows what is still booked: totals are recomputed and the unpaid schedule rescaled to the
 * new total, keeping its shape. A booking with nothing left is cancelled.
 */
export async function recalcBookingTotals(tx: Tx, bookingIds: string[]) {
  for (const id of [...new Set(bookingIds)]) {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
    if (!b || b.status === "cancelled") continue;
    const live = await tx.select().from(fulfilments).where(and(eq(fulfilments.bookingId, id), isNull(fulfilments.cancelledAt)));
    const subtotal = live.reduce((a, f) => a + f.amountPaise, 0);
    const gst = live.reduce((a, f) => a + f.gstPaise, 0);
    if (subtotal === b.subtotalPaise && gst === b.gstPaise) continue;
    if (live.length === 0) {
      await tx.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "requirements_cancelled", subtotalPaise: 0, gstPaise: 0, version: b.version + 1 }).where(eq(bookings.id, id));
      continue;
    }
    const ms = await tx.select().from(paymentMilestones).where(eq(paymentMilestones.bookingId, id)).orderBy(asc(paymentMilestones.sortOrder));
    if (ms.length) {
      const parts = allocate(subtotal + gst, ms.map((m) => m.amountPaise));
      for (let i = 0; i < ms.length; i++) await tx.update(paymentMilestones).set({ amountPaise: parts[i] }).where(eq(paymentMilestones.id, ms[i].id));
    }
    await tx.update(bookings).set({ subtotalPaise: subtotal, gstPaise: gst, version: b.version + 1 }).where(eq(bookings.id, id));
  }
}

/** Booking ids with active fulfilments matching a condition (before cancelling them). */
export async function bookingsOf(tx: Tx, where: { requirementId?: string; serviceId?: string }) {
  const rows = await tx
    .selectDistinct({ id: fulfilments.bookingId })
    .from(fulfilments)
    .where(
      and(
        isNull(fulfilments.cancelledAt),
        where.requirementId ? eq(fulfilments.requirementId, where.requirementId) : undefined,
        where.serviceId ? eq(fulfilments.serviceId, where.serviceId) : undefined,
      ),
    );
  return rows.map((r) => r.id);
}

