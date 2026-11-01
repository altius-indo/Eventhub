/**
 * "Wall-clock" times are event-local times stored in `timestamp without time zone`
 * columns and handled as Dates whose UTC fields hold the local time (see travel.ts).
 * Never compare them with `new Date()` directly: use `wallClockNow(event.timezone)`.
 */

/** The current event-local time as a wall-clock Date. */
export function wallClockNow(timeZone: string, now = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second));
}

/** "2026-12-09T14:30" (from <input type="datetime-local">) → wall-clock Date, or null. */
export function parseWallClock(value: string | null | undefined): Date | null {
  return value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? new Date(`${value}:00Z`) : null;
}

/** Wall-clock Date → "2026-12-09T14:30" for <input type="datetime-local">. */
export function toWallClockInput(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 16) : "";
}

/** The calendar day ("YYYY-MM-DD") of a wall-clock Date. */
export function wallClockDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const addMinutes = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);
