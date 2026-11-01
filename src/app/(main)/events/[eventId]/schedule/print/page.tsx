import { PrintButton } from "@/components/print-button";
import { getDb } from "@/db";
import { formatDateTime, formatDay, formatTime } from "@/i18n/core";
import { groupByDay, listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Master itinerary for printing / PDF (ITN-07). */
export default async function SchedulePrint({ params }: PageProps<"/events/[eventId]/schedule/print">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const fns = await listFunctions(getDb(), eventId);
  return (
    <article className="print-sheet mx-auto max-w-3xl bg-white p-6 text-black">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{ctx.event.name}</h1>
          <p className="text-sm">{[ctx.event.coupleNames, ctx.event.city].filter(Boolean).join(" · ")}</p>
        </div>
        <PrintButton label={t("logistics.print")} />
      </div>
      {groupByDay(fns).map((day) => (
        <section key={day.date ?? "undated"} className="mb-4" style={{ breakInside: "avoid" }}>
          <h2 className="border-b border-black text-lg font-semibold">{day.date ? formatDay(locale, day.date, { dateStyle: "full" }) : t("schedule.undated")}</h2>
          {day.functions.map((fn) => (
            <div key={fn.id} className="mt-2">
              <p className="font-semibold">
                {fn.startTime && `${formatTime(locale, fn.startTime)} · `}
                {fn.name}
              </p>
              <p className="text-sm">{[fn.venueName, fn.venueAddress].filter(Boolean).join(", ")}</p>
              {fn.dressCode && (
                <p className="text-sm">
                  {t("schedule.dressCode")}: {fn.dressCode}
                </p>
              )}
            </div>
          ))}
        </section>
      ))}
      <p className="mt-4 text-xs">{t("logistics.printedAt", { time: formatDateTime(locale, new Date()) })}</p>
    </article>
  );
}
