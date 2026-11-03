import Link from "next/link";
import { Card, PageHeader, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatTime } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { headcounts } from "@/lib/rsvp";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

function Bar({ parts }: { parts: { value: number; className: string; label: string }[] }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-muted" role="img" aria-label={parts.map((p) => `${p.label}: ${p.value}`).join(", ")}>
      {parts.map((p) => (
        <span key={p.label} className={p.className} style={{ width: `${(p.value / total) * 100}%` }} />
      ))}
    </div>
  );
}

export default async function RsvpPage({ params }: PageProps<"/events/[eventId]/rsvp">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const [fns, counts] = await Promise.all([listFunctions(db, eventId), headcounts(db, eventId)]);
  const guestsHref = (fn: string, rsvp: string) => `/events/${eventId}/guests?fn=${fn}&rsvp=${rsvp}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("rsvp.headcountTitle")}
        subtitle={ctx.event.rsvpDeadline ? `${t("rsvp.deadline")}: ${formatDay(locale, ctx.event.rsvpDeadline)}` : undefined}
        action={
          <a href={`/events/${eventId}/rsvp/export`} className={buttonClass("secondary")}>
            {t("rsvp.headcountExport")}
          </a>
        }
      />
      {fns.length === 0 && (
        <Card>
          <p className="text-muted">{t("guests.noFunctionsYet")}</p>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {fns.map((fn) => {
          const c = counts.get(fn.id);
          return (
            <Card key={fn.id} id={`fn-${fn.id}`} className="scroll-mt-20">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{fn.name}</h2>
                <span className="text-sm text-muted">
                  {[fn.date && formatDay(locale, fn.date, { day: "numeric", month: "short" }), fn.startTime && formatTime(locale, fn.startTime)].filter(Boolean).join(" · ")}
                </span>
              </div>
              {!c ? (
                <p className="text-sm text-muted">{t("schedule.invitedCount", { guests: 0, households: 0 })}</p>
              ) : (
                <>
                  <dl className="mb-3 grid grid-cols-4 gap-2 text-center">
                    {(["attending", "maybe", "declined", "pending"] as const).map((k) => (
                      <Link key={k} href={guestsHref(fn.id, k)} className="rounded-lg bg-surface-muted px-1 py-2 hover:ring-1 hover:ring-primary">
                        <dd className="text-xl font-semibold">{c[k]}</dd>
                        <dt className="text-xs text-muted">{t(`rsvp.${k}`)}</dt>
                      </Link>
                    ))}
                  </dl>
                  <Bar
                    parts={[
                      { value: c.attending, className: "bg-success", label: t("rsvp.attending") },
                      { value: c.maybe, className: "bg-warning", label: t("rsvp.maybe") },
                      { value: c.declined, className: "bg-danger", label: t("rsvp.declined") },
                      { value: c.pending, className: "bg-border", label: t("rsvp.pending") },
                    ]}
                  />
                  <p className="mt-2 text-sm text-muted">
                    {t("rsvp.invited")}: {c.invited} · {t("rsvp.responded", { responded: c.households.responded, invited: c.households.invited })}
                  </p>
                  {c.attending > 0 && (
                    <div className="mt-3 grid gap-2 border-t border-border pt-3 text-sm sm:grid-cols-3">
                      <div>
                        <p className="font-medium">{t("rsvp.bySide")}</p>
                        <p className="text-muted">
                          {t("sides.bride")}: {c.attendingBy.side.bride}
                          <br />
                          {t("sides.groom")}: {c.attendingBy.side.groom}
                          <br />
                          {t("sides.both")}: {c.attendingBy.side.both}
                        </p>
                      </div>
                      <div>
                        <p className="font-medium">{t("rsvp.byAge")}</p>
                        <p className="text-muted">
                          {t("ages.adult")}: {c.attendingBy.age.adult}
                          <br />
                          {t("ages.child")}: {c.attendingBy.age.child}
                          <br />
                          {t("ages.infant")}: {c.attendingBy.age.infant}
                        </p>
                      </div>
                      <div>
                        <p className="font-medium">{t("rsvp.byFood")}</p>
                        <p className="text-muted">
                          {(["veg", "non_veg", "jain", "vegan", "other"] as const)
                            .filter((d) => c.attendingBy.diet[d] > 0)
                            .map((d) => `${t(`diets.${d}`)}: ${c.attendingBy.diet[d]}`)
                            .concat(c.attendingBy.diet.unknown ? [`${t("rsvp.unknownDiet")}: ${c.attendingBy.diet.unknown}`] : [])
                            .join(" · ")}
                          {c.attendingBy.allergies > 0 && (
                            <>
                              <br />
                              {t("rsvp.allergies")}: {c.attendingBy.allergies}
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
