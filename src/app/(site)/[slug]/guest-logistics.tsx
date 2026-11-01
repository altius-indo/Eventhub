import type { Event, Household } from "@/db/schema";
import { formatDay, formatWallClock, type Locale, type Translator } from "@/i18n/core";
import { getDb } from "@/db";
import { formatPhone } from "@/lib/guests";
import { roomsForHousehold } from "@/lib/hotels";
import { tablesForHousehold } from "@/lib/seating";
import { runsForHousehold } from "@/lib/transfers";

/**
 * A family's own pickups, rooms and tables (ITN-04), each shown only once the team shares it.
 * Never includes other families' names, rates or anything beyond the family's own bookings.
 */
export async function GuestLogistics({
  event,
  household,
  memberNames,
  t,
  locale,
  cardClass,
  headingClass,
}: {
  event: Event;
  household: Household;
  memberNames: Map<string, string>;
  t: Translator;
  locale: Locale;
  cardClass: string;
  headingClass: string;
}) {
  const db = getDb();
  const [runs, stays, tables] = await Promise.all([
    event.shareTransfers ? runsForHousehold(db, event.id, household.id) : Promise.resolve([]),
    event.shareRooms ? roomsForHousehold(db, event.id, household.id) : Promise.resolve([]),
    event.shareSeating ? tablesForHousehold(db, event.id, household.id) : Promise.resolve([]),
  ]);
  if (!runs.length && !stays.length && !tables.length) return null;
  const day = (d: string) => formatDay(locale, d, { day: "numeric", month: "long" });
  return (
    <div className="space-y-6">
      {runs.length > 0 && (
        <section>
          <h3 className={`mb-3 text-xl ${headingClass}`}>{t("itinerary.yourTravel")}</h3>
          <ul className="space-y-3">
            {runs.map(({ run, guestIds }) => (
              <li key={run.id} className={`rounded-2xl p-4 ${cardClass}`} style={{ breakInside: "avoid" }}>
                <p className="font-semibold">
                  {t(`transfers.kinds.${run.kind}`)} · {formatWallClock(locale, run.departsAt, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                </p>
                <p>
                  {run.fromPlace} → {run.toPlace}
                </p>
                {guestIds.length > 0 && <p className="text-sm opacity-80">{guestIds.map((id) => memberNames.get(id)).filter(Boolean).join(", ")}</p>}
                <p className="text-sm opacity-80">
                  {[run.vehicle && `${t("itinerary.vehicle")}: ${run.vehicle}`, run.driverName && `${t("itinerary.driver")}: ${run.driverName}`].filter(Boolean).join(" · ")}
                  {run.driverPhone && (
                    <>
                      {" · "}
                      <a href={`tel:${run.driverPhone}`} className="underline">
                        {formatPhone(run.driverPhone)}
                      </a>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {stays.length > 0 && (
        <section>
          <h3 className={`mb-3 text-xl ${headingClass}`}>{t("itinerary.yourStay")}</h3>
          <ul className="space-y-3">
            {stays.map((s, i) => (
              <li key={i} className={`rounded-2xl p-4 ${cardClass}`} style={{ breakInside: "avoid" }}>
                <p className="font-semibold">{s.hotel.name}</p>
                {s.hotel.address && <p className="whitespace-pre-line text-sm opacity-80">{s.hotel.address}</p>}
                <p className="text-sm">
                  {s.roomType} · {s.label ? `${t("itinerary.room")} ${s.label}` : t("itinerary.roomTbc")}
                </p>
                <p className="text-sm">{t("itinerary.nights", { in: day(s.checkIn), out: day(s.checkOut) })}</p>
                <p className="text-sm opacity-80">{s.names.join(", ")}</p>
                <div className="mt-1 flex flex-wrap gap-3 text-sm">
                  {s.hotel.phone && (
                    <a href={`tel:${s.hotel.phone}`} className="underline">
                      {formatPhone(s.hotel.phone)}
                    </a>
                  )}
                  {s.hotel.mapUrl && (
                    <a href={s.hotel.mapUrl} target="_blank" rel="noopener noreferrer" className="underline">
                      {t("schedule.map")} ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm opacity-80">{t("itinerary.carryId")}</p>
        </section>
      )}
      {tables.length > 0 && (
        <section>
          <h3 className={`mb-3 text-xl ${headingClass}`}>{t("itinerary.yourTables")}</h3>
          <ul className={`rounded-2xl p-4 ${cardClass}`}>
            {tables.map((tb) => (
              <li key={`${tb.functionId}-${tb.tableName}`}>{t("itinerary.table", { function: tb.functionName, table: tb.tableName })}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
