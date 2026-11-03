/**
 * Registers every change type that goes through Host approval (ADR-0005, ADR-0016).
 * Each feature module registers its own handlers when imported; importing this file
 * guarantees they are all registered before a Host decides on a request.
 *
 *   services.ts  service.create, requirement.create/update/cancel, service.cancel
 *   budget.ts    budget_line.create/update/delete
 *   bookings.ts  booking.create/change/cancel/schedule
 *   payments.ts  payment.record
 */
import "./services";
import "./budget";
import "./bookings";
import "./payments";

export const APPROVAL_TYPES = [
  "service.create",
  "service.cancel",
  "requirement.create",
  "requirement.update",
  "requirement.cancel",
  "budget_line.create",
  "budget_line.update",
  "budget_line.delete",
  "booking.create",
  "booking.change",
  "booking.cancel",
  "booking.schedule",
  "payment.record",
] as const;
