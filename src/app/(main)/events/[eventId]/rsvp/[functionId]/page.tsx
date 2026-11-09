import Link from "next/link";
import { notFound } from "next/navigation";
import { ListFilterBar } from "@/components/list-filter-bar";
import { MobileCollapse } from "@/components/mobile-collapse";
import { FamilyRsvpButtons, RsvpSegment } from "@/components/rsvp-desk";
import { Badge, Card, PageHeader, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatTime } from "@/i18n/core";
import { getFunction } from "@/lib/functions";
import { formatPhone } from "@/lib/guests";
import { isUuid } from "@/lib/ids";
import { rsvpDesk } from "@/lib/rsvp";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { deskFamilyAction, deskRsvpAction } from "./actions";

const sideTone = { bride: "primary", groom: "success", both: "neutral" } as const;

/** RSVP desk for one function (RSV-04): Hosts and Planners record replies, e.g. while phoning families. */
export default async function RsvpDeskPage({ params, searchParams }: PageProps<"/events/[eventId]/rsvp/[functionId]">) {
  const { eventId, functionId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("rsvp.edit") || !isUuid(functionId)) notFound();
  const db = getDb();
  const fn = await getFunction(db, eventId, functionId).catch(() => null);
  if (!fn) notFound();
  const { t, locale } = await getTranslator();

  const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 100) : "");
  const values = { q: str(sp.q), status: str(sp.status) };
  const page = Math.max(1, Number(sp.page) || 1);
  const desk = await rsvpDesk(db, eventId, functionId, { q: values.q, status: values.status, page });
  const filtered = Boolean(values.q || values.status);
  const activeValues = Object.fromEntries(Object.entries(values).filter(([, v]) => v)) as Record<string, string>;
  const base = `/events/${eventId}/rsvp/${functionId}`;
  const pageHref = (p: number) => `${base}?${new URLSearchParams({ ...activeValues, page: String(p) }).toString()}`;

  const memberAction = deskRsvpAction.bind(null, eventId, functionId);
  const familyAction = deskFamilyAction.bind(null, eventId, functionId);
  const segmentLabels = { attending: t("rsvp.attending"), maybe: t("rsvp.maybe"), declined: t("rsvp.declined"), clear: t("rsvp.desk.clear") };
  const when = [fn.date && formatDay(locale, fn.date, { weekday: "short", day: "numeric", month: "short" }), fn.startTime && formatTime(locale, fn.startTime)].filter(Boolean).join(" · ");

  return (
    <div className="space-y-4">
      <Link href={`/events/${eventId}/rsvp#fn-${functionId}`} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
        ← {t("rsvp.desk.back")}
      </Link>
      <PageHeader title={t("rsvp.desk.title", { name: fn.name })} subtitle={when || undefined} />
      <p className="text-sm text-muted">{t("rsvp.desk.help")}</p>

      <dl className="grid grid-cols-3 gap-2 text-center sm:grid-cols-5" data-testid="desk-counts">
        {(
          [
            ["invited", t("rsvp.invited"), ""],
            ["attending", t("rsvp.attending"), "attending"],
            ["maybe", t("rsvp.maybe"), "maybe"],
            ["declined", t("rsvp.declined"), "declined"],
            ["pending", t("rsvp.pending"), "pending"],
          ] as const
        ).map(([k, label, tab]) => (
          <Link
            key={k}
            href={tab ? `${base}?status=${tab}` : base}
            data-count={k}
            className="flex min-h-11 flex-col justify-center rounded-lg bg-surface-muted px-1 py-2 hover:ring-1 hover:ring-primary"
          >
            <dd className="text-xl font-semibold">{desk.counts[k]}</dd>
            <dt className="text-xs text-muted">{label}</dt>
          </Link>
        ))}
      </dl>

      <Card>
        <MobileCollapse label={t("common.searchFilters")} activeLabel={t("common.filtersOn")} activeCount={Object.keys(activeValues).length}>
          <ListFilterBar
            values={activeValues}
            search={{ name: "q", label: t("rsvp.desk.search"), placeholder: t("rsvp.desk.search") }}
            tabs={{
              name: "status",
              label: t("rsvp.desk.tabsLabel"),
              options: [
                { value: "", label: t("rsvp.desk.tabs.all") },
                { value: "pending", label: t("rsvp.desk.tabs.pending") },
                { value: "attending", label: t("rsvp.desk.tabs.attending") },
                { value: "maybe", label: t("rsvp.desk.tabs.maybe") },
                { value: "declined", label: t("rsvp.desk.tabs.declined") },
              ],
            }}
            chips={[]}
            selects={[]}
            labels={{ quick: "", more: "", moreActive: "", clear: t("guests.clear") }}
          />
        </MobileCollapse>
      </Card>

      {desk.counts.invited === 0 ? (
        <Card>
          <p className="text-muted">{t("rsvp.desk.empty")}</p>
        </Card>
      ) : desk.households.length === 0 ? (
        <Card>
          <p className="text-muted">{t("rsvp.desk.noMatches")}</p>
        </Card>
      ) : (
        <>
          {filtered && <p className="text-sm text-muted">{t("rsvp.desk.matching", { count: desk.matchingGuests })}</p>}
          <ul className="space-y-3">
            {desk.households.map((h) => (
              <li key={h.id}>
                <Card className="p-0 sm:p-0" data-testid="desk-family">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{h.name}</span>
                      <Badge tone={sideTone[h.side]}>{t(`sides.${h.side}`)}</Badge>
                    </div>
                    <Link href={`/events/${eventId}/guests/${h.id}`} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
                      {t("rsvp.desk.mealsLink")} →
                    </Link>
                  </div>
                  <ul className="divide-y divide-border">
                    {h.members.map((m) => (
                      <li key={m.id} className="space-y-2 px-4 py-3" data-testid="desk-member">
                        <p className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{m.name}</span>
                          {m.ageGroup !== "adult" && <Badge>{t(`ages.${m.ageGroup}`)}</Badge>}
                          <span className="text-sm text-muted">{[m.relation, formatPhone(m.phone)].filter(Boolean).join(" · ")}</span>
                        </p>
                        <RsvpSegment action={memberAction} guestId={m.id} status={m.status} label={t("rsvp.desk.replyFor", { name: m.name })} labels={segmentLabels} />
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-border px-4 py-3">
                    {h.members.length < h.invitedMembers ? (
                      <FamilyRsvpButtons
                        action={familyAction}
                        householdId={h.id}
                        guestIds={h.members.map((m) => m.id)}
                        labels={{ attending: t("rsvp.desk.shownAttending", { count: h.members.length }), declined: t("rsvp.desk.shownDeclined", { count: h.members.length }) }}
                      />
                    ) : (
                      <FamilyRsvpButtons action={familyAction} householdId={h.id} labels={{ attending: t("rsvp.desk.wholeAttending"), declined: t("rsvp.desk.wholeDeclined") }} />
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          {desk.pages > 1 && (
            <nav aria-label={t("rsvp.desk.pages")} className="flex items-center justify-between gap-2 text-sm">
              {desk.page > 1 ? (
                <Link href={pageHref(desk.page - 1)} className={buttonClass("secondary")}>
                  ← {t("guests.previous")}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted">{t("guests.page", { page: desk.page, pages: desk.pages })}</span>
              {desk.page < desk.pages ? (
                <Link href={pageHref(desk.page + 1)} className={buttonClass("secondary")}>
                  {t("guests.next")} →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
