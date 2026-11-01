import Link from "next/link";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatTime } from "@/i18n/core";
import { groupByDay, invitedCounts, listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function SchedulePage({ params }: PageProps<"/events/[eventId]/schedule">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const fns = await listFunctions(db, eventId);
  const counts = await invitedCounts(db, eventId);
  const canEdit = ctx.can("itinerary.edit");
  const base = `/events/${eventId}/schedule`;

  return (
    <div>
      <PageHeader
        title={t("schedule.title")}
        action={
          <div className="flex flex-wrap gap-2">
            {fns.length > 0 && (
              <Link href={`${base}/print`} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-primary hover:bg-primary-soft">
                {t("schedule.printItinerary")}
              </Link>
            )}
            {fns.some((f) => f.date) && (
              <a href={`${base}/calendar.ics`} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-primary hover:bg-primary-soft">
                {t("schedule.calendar")}
              </a>
            )}
            {canEdit && <LinkButton href={`${base}/new`}>{t("schedule.addFunction")}</LinkButton>}
          </div>
        }
      />
      {fns.length === 0 ? (
        <Card>
          <p className="text-muted">{t("schedule.empty")}</p>
        </Card>
      ) : (
        <ol className="space-y-6">
          {groupByDay(fns).map((day) => (
            <li key={day.date ?? "undated"}>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
                {day.date ? formatDay(locale, day.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : t("schedule.undated")}
              </h2>
              <ol className="space-y-3 border-l-2 border-border pl-4">
                {day.functions.map((fn) => {
                  const c = counts.get(fn.id) ?? { guests: 0, households: 0, adults: 0, children: 0, infants: 0 };
                  return (
                    <li key={fn.id} className="relative">
                      <span aria-hidden className="absolute -left-[1.4rem] top-5 h-2.5 w-2.5 rounded-full border-2 border-primary bg-surface" />
                      <Card>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                              {fn.name}
                              <Badge tone={fn.isPublic ? "success" : "neutral"}>{fn.isPublic ? t("schedule.public") : t("schedule.private")}</Badge>
                            </h3>
                            <p className="text-sm text-muted">
                              {[
                                fn.startTime && `${formatTime(locale, fn.startTime)}${fn.endTime ? ` – ${formatTime(locale, fn.endTime)}` : ""}`,
                                fn.venueName,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                          {canEdit && (
                            <Link href={`${base}/${fn.id}`} className="min-h-11 rounded-lg px-3 py-2.5 text-sm text-primary hover:bg-primary-soft">
                              {t("schedule.edit")}
                            </Link>
                          )}
                        </div>
                        {fn.venueAddress && <p className="mt-1 whitespace-pre-line text-sm">{fn.venueAddress}</p>}
                        {fn.dressCode && (
                          <p className="mt-1 text-sm">
                            <span className="text-muted">{t("schedule.dressCode")}:</span> {fn.dressCode}
                          </p>
                        )}
                        {fn.description && <p className="mt-2 whitespace-pre-line text-sm">{fn.description}</p>}
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                          <Link href={`/events/${eventId}/guests?fn=${fn.id}`} className="text-primary hover:underline">
                            {t("schedule.invitedCount", { guests: c.guests, households: c.households })}
                          </Link>
                          {c.guests > 0 && <span className="text-muted">{t("schedule.ageBreakdown", c)}</span>}
                          <Link href={`${base}/${fn.id}/run-sheet`} className="text-primary hover:underline">
                            {t("schedule.runSheet")}
                          </Link>
                          <Link href={`${base}/${fn.id}/seating`} className="text-primary hover:underline">
                            {t("schedule.seating")}
                          </Link>
                          {fn.mapUrl && (
                            <a href={fn.mapUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              {t("schedule.map")} ↗
                            </a>
                          )}
                        </div>
                      </Card>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
