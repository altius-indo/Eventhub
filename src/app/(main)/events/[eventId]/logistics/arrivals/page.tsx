import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, PageHeader, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatWallClock } from "@/i18n/core";
import { formatPhone } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { arrivalsBoard, listRuns, travelDays } from "@/lib/transfers";
import { assignSelectedAction } from "../actions";

export default async function ArrivalsPage({ params, searchParams }: PageProps<"/events/[eventId]/logistics/arrivals">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const direction = sp.dir === "departure" ? "departure" : "arrival";
  const windowMinutes = [30, 60, 120].includes(Number(sp.window)) ? Number(sp.window) : 60;
  const days = await travelDays(db, eventId);
  const date = typeof sp.date === "string" && days.includes(sp.date) ? sp.date : (days.find((d) => d >= (ctx.event.startDate ?? "")) ?? days[0]);
  const board = date ? await arrivalsBoard(db, eventId, { date, windowMinutes, direction }) : [];
  const kind = direction === "arrival" ? "pickup" : "drop";
  const runs = (await listRuns(db, eventId)).filter((r) => r.run.kind === kind);
  const canEdit = ctx.can("travel.edit");
  const time = (d: Date) => formatWallClock(locale, d, { timeStyle: "short" });

  return (
    <div className="space-y-4">
      <PageHeader title={direction === "arrival" ? t("logistics.arrivals") : t("logistics.departures")} />
      <Card>
        <form className="flex flex-wrap items-end gap-2" role="search">
          <Select name="dir" defaultValue={direction} className="w-auto" aria-label={t("transfers.kind")}>
            <option value="arrival">{t("logistics.arrivals")}</option>
            <option value="departure">{t("logistics.departures")}</option>
          </Select>
          <Select name="date" defaultValue={date ?? ""} className="w-auto" aria-label={t("logistics.day")}>
            {days.map((d) => (
              <option key={d} value={d}>
                {formatDay(locale, d, { weekday: "short", day: "numeric", month: "short" })}
              </option>
            ))}
          </Select>
          <Select name="window" defaultValue={String(windowMinutes)} className="w-auto" aria-label={t("logistics.windowMinutes")}>
            {[30, 60, 120].map((n) => (
              <option key={n} value={n}>
                {t("logistics.windowMinutes")}: {t("logistics.minutes", { n })}
              </option>
            ))}
          </Select>
          <button type="submit" className={buttonClass("secondary")}>
            {t("guests.filter")}
          </button>
        </form>
      </Card>

      {board.length === 0 ? (
        <Card>
          <p className="text-muted">{t("logistics.noTravel")}</p>
        </Card>
      ) : (
        <SimpleForm action={assignSelectedAction.bind(null, eventId)} className="space-y-4">
          <input type="hidden" name="kind" value={kind} />
          {board.map((w) => (
            <Card key={w.start.toISOString()} className="p-0 sm:p-0">
              <h2 className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 font-semibold">
                {time(w.start)} – {time(new Date(w.start.getTime() + windowMinutes * 60_000))}
                <Badge>{t("logistics.people", { count: w.entries.length })}</Badge>
              </h2>
              <ul className="divide-y divide-border">
                {w.entries.map((e) => (
                  <li key={e.guest.id} className="flex items-start gap-3 px-4 py-2.5">
                    {canEdit && (
                      <label className="flex min-h-11 min-w-11 items-center justify-center">
                        <span className="sr-only">{e.guest.name}</span>
                        <input type="checkbox" name="guestIds" value={e.guest.id} className="h-5 w-5" />
                      </label>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{e.guest.name}</span>
                        <Link href={`/events/${eventId}/guests/${e.household.id}`} className="text-sm text-muted hover:underline">
                          {e.household.name}
                        </Link>
                        {e.runIds.length > 0 ? (
                          <Badge tone="success">{t("logistics.onRun")}</Badge>
                        ) : e.needs ? (
                          <Badge tone="warning">{direction === "arrival" ? t("logistics.needsPickup") : t("logistics.needsDrop")}</Badge>
                        ) : (
                          <Badge>{t("logistics.selfArranged")}</Badge>
                        )}
                      </p>
                      <p className="text-sm text-muted">
                        {[
                          time(e.at),
                          direction === "arrival" ? e.travel.arrivalNumber : e.travel.departureNumber,
                          e.point,
                          e.guest.ageGroup !== "adult" && t(`ages.${e.guest.ageGroup}`),
                          formatPhone(e.guest.phone),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
          {canEdit && (
            <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur">
              {runs.length > 0 && (
                <>
                  <Select name="runId" className="w-auto min-w-0 max-w-full" aria-label={t("logistics.assignTo")}>
                    {runs.map((r) => (
                      <option key={r.run.id} value={r.run.id}>
                        {time(r.run.departsAt)} · {r.run.fromPlace} → {r.run.toPlace} ({r.passengers}/{r.run.capacity})
                      </option>
                    ))}
                  </Select>
                  <SubmitButton variant="secondary" name="op" value="assign">
                    {t("logistics.assignTo")}
                  </SubmitButton>
                </>
              )}
              <SubmitButton name="op" value="new">
                {t("logistics.newRunFromSelected")}
              </SubmitButton>
            </div>
          )}
        </SimpleForm>
      )}
    </div>
  );
}
