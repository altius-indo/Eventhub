import Link from "next/link";
import { getDb } from "@/db";
import { Card, CardTitle, LinkButton } from "@/components/ui";
import { formatDay, formatInrShort, formatTime } from "@/i18n/core";
import { budgetFacts, sumFacts } from "@/lib/budget";
import { payables } from "@/lib/payments";
import { gapView } from "@/lib/services";
import { countPendingApprovals } from "@/lib/approvals";
import { memberCounts } from "@/lib/events";
import { invitedCounts, listFunctions } from "@/lib/functions";
import { guestStats } from "@/lib/guests";
import { headcounts } from "@/lib/rsvp";
import { arrivalsBoard } from "@/lib/transfers";
import { giftSummary } from "@/lib/gifts";
import { taskSummary, todayIn } from "@/lib/tasks";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Whole days from today (in the event's timezone) to an ISO date. */
function daysUntil(isoDate: string, today: string): number {
  return Math.round((Date.parse(isoDate) - Date.parse(today)) / 86_400_000);
}

const FUNNEL = ["invited", "responded", "attending", "maybe", "declined", "pending"] as const;

export default async function EventDashboard({ params }: PageProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const { event } = ctx;
  const today = todayIn(event.timezone);
  // RPT-01: every card's data in one round of parallel queries.
  const canGifts = ctx.can("gifts.view");
  const [counts, pendingMap, stats, fns, invited, tasks, facts, due, gaps, heads, arrivals, gifts] = await Promise.all([
    memberCounts(db, eventId),
    countPendingApprovals(db, [eventId]),
    guestStats(db, eventId),
    listFunctions(db, eventId),
    invitedCounts(db, eventId),
    taskSummary(db, eventId, today),
    budgetFacts(db, eventId),
    payables(db, eventId, today, new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)),
    gapView(db, eventId, today),
    headcounts(db, eventId),
    // Travel times are wall-clock in the event's timezone, so "today" there is the right day.
    arrivalsBoard(db, eventId, { date: today, windowMinutes: 24 * 60, direction: "arrival" }),
    canGifts ? giftSummary(db, { eventId, actor: ctx.actor, subject: ctx.subject }) : null,
  ]);
  const funnel = { invited: 0, responded: 0, attending: 0, maybe: 0, declined: 0, pending: 0 };
  for (const h of heads.values()) {
    funnel.invited += h.invited;
    funnel.attending += h.attending;
    funnel.maybe += h.maybe;
    funnel.declined += h.declined;
    funnel.pending += h.pending;
  }
  funnel.responded = funnel.attending + funnel.maybe + funnel.declined;
  const arriving = arrivals.flatMap((w) => w.entries);
  const needPickup = arriving.filter((a) => a.needs);
  const onRun = needPickup.filter((a) => a.runIds.length > 0).length;
  const invitedFns = fns.filter((f) => heads.has(f.id));
  const money = sumFacts(facts);
  const overdue = due.filter((d) => d.status === "overdue").length;
  const pending = pendingMap.get(eventId) ?? 0;
  const next = fns.find((f) => f.date && f.date >= today);
  const base = `/events/${eventId}`;

  let countdown = t("dashboard.noDate");
  if (event.startDate) {
    const days = daysUntil(event.startDate, today);
    const endDays = event.endDate ? daysUntil(event.endDate, today) : days;
    countdown =
      days > 1 ? t("dashboard.daysToGo", { days }) : days === 1 ? t("dashboard.oneDayToGo") : endDays >= 0 ? t("dashboard.today") : t("dashboard.past");
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card className="sm:col-span-2 lg:col-span-1">
        <p className="text-3xl font-semibold">{countdown}</p>
        <p className="mt-1 text-sm text-muted">{[event.coupleNames, event.city].filter(Boolean).join(" · ")}</p>
      </Card>

      <Card>
        <CardTitle action={<Link href={`${base}/schedule`} className="text-sm text-primary" aria-label={t("nav.schedule")}>→</Link>}>
          {t("dashboard.nextFunction")}
        </CardTitle>
        {next ? (
          <Link href={`${base}/schedule#fn-${next.id}`} className="-mx-2 block min-h-11 rounded-lg px-2 py-1 hover:bg-primary-soft">
            <p className="font-medium text-primary">{next.name}</p>
            <p className="text-sm text-muted">
              {[formatDay(locale, next.date!, { weekday: "short", day: "numeric", month: "short" }), next.startTime && formatTime(locale, next.startTime), next.venueName]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mt-1 text-sm text-muted">
              {t("schedule.invitedCount", { guests: invited.get(next.id)?.guests ?? 0, households: invited.get(next.id)?.households ?? 0 })}
            </p>
          </Link>
        ) : (
          <p className="text-sm text-muted">{t("dashboard.noFunctions")}</p>
        )}
      </Card>

      <Card>
        <CardTitle action={<Link href={`${base}/guests`} className="text-sm text-primary" aria-label={t("nav.guests")}>→</Link>}>
          {t("dashboard.guestsCard")}
        </CardTitle>
        <p className="text-2xl font-semibold">{stats.guests}</p>
        <p className="text-sm text-muted">{t("dashboard.guestsSummary", { guests: stats.guests, households: stats.households })}</p>
        {stats.guests > 0 && <p className="mt-1 text-sm text-muted">{t("guests.stats", stats)}</p>}
      </Card>

      <Card>
        <CardTitle action={<Link href={`${base}/tasks`} className="text-sm text-primary" aria-label={t("nav.tasks")}>→</Link>}>
          {t("dashboard.tasksCard")}
        </CardTitle>
        <p className={`text-2xl font-semibold ${tasks.overdue > 0 ? "text-danger" : ""}`}>{tasks.overdue + tasks.dueThisWeek}</p>
        <p className="text-sm text-muted">{t("dashboard.tasksSummary", { overdue: tasks.overdue, week: tasks.dueThisWeek, open: tasks.open })}</p>
      </Card>

      {gifts && (
        <Card>
          <CardTitle action={<Link href={`${base}/gifts`} className="text-sm text-primary" aria-label={t("nav.gifts")}>→</Link>}>
            {t("gifts.dashboard.title")}
          </CardTitle>
          {gifts.items === 0 ? (
            <p className="text-sm text-muted">{t("gifts.dashboard.empty")}</p>
          ) : (
            <>
              <p className="text-2xl font-semibold">{t("gifts.dashboard.line", { done: gifts.itemsDone, count: gifts.items })}</p>
              <p className={`text-sm ${gifts.dueSoon > 0 ? "text-warning" : "text-muted"}`}>{t("gifts.dashboard.due", { count: gifts.dueSoon })}</p>
            </>
          )}
        </Card>
      )}

      <Card>
        <CardTitle action={<Link href={`${base}/members`} className="text-sm text-primary" aria-label={t("nav.members")}>→</Link>}>
          {t("dashboard.team")}
        </CardTitle>
        <p>{t("dashboard.teamSummary", { hosts: counts.hosts, planners: counts.planners })}</p>
        {counts.invites > 0 && <p className="mt-1 text-sm text-muted">{t("dashboard.pendingInvites", { count: counts.invites })}</p>}
      </Card>

      <Card>
        <CardTitle>{t("dashboard.waitingApproval")}</CardTitle>
        <p className="text-2xl font-semibold">{pending}</p>
        {pending > 0 && (
          <LinkButton href={`${base}/approvals`} variant="secondary" className="mt-3">
            {t("dashboard.viewApprovals")}
          </LinkButton>
        )}
      </Card>

      <Card>
        <CardTitle action={<Link href={`${base}/budget`} className="text-sm text-primary" aria-label={t("nav.budget")}>→</Link>}>
          {t("dashboard.budgetCard")}
        </CardTitle>
        <p className={`text-2xl font-semibold ${money.committed > money.planned ? "text-danger" : ""}`}>{formatInrShort(locale, money.committed)}</p>
        <p className="text-sm text-muted">
          {t("dashboard.budgetSummary", { planned: formatInrShort(locale, money.planned), paid: formatInrShort(locale, money.paid) })}
        </p>
        {gaps.length > 0 && (
          <Link href={`${base}/services/gaps`} className="mt-1 block text-sm text-primary underline">
            {t("dashboard.gaps", { count: gaps.length })}
          </Link>
        )}
      </Card>

      <Card>
        <CardTitle action={<Link href={`${base}/budget/payables?period=week`} className="text-sm text-primary" aria-label={t("budget.payables")}>→</Link>}>
          {t("dashboard.paymentsCard")}
        </CardTitle>
        <p className={`text-2xl font-semibold ${overdue > 0 ? "text-danger" : ""}`}>{due.length}</p>
        <p className="text-sm text-muted">{t("dashboard.paymentsSummary", { overdue, amount: formatInrShort(locale, due.reduce((a, d) => a + d.remaining, 0)) })}</p>
      </Card>

      <Card>
        <CardTitle action={<Link href={`${base}/rsvp`} className="text-sm text-primary" aria-label={t("nav.rsvp")}>→</Link>}>
          {t("dashboard.rsvpCard")}
        </CardTitle>
        {funnel.invited > 0 ? (
          <>
            <dl className="space-y-1.5">
              {FUNNEL.map((key) => {
                const n = funnel[key];
                const pct = Math.round((n / funnel.invited) * 100);
                return (
                  <div key={key}>
                    <div className="flex justify-between text-sm">
                      <dt>{t(`dashboard.funnel.${key}`)}</dt>
                      <dd className="font-medium tabular-nums">{key === "invited" ? n : `${n} · ${pct}%`}</dd>
                    </div>
                    <div className="mt-0.5 h-1.5 rounded-full bg-surface-muted" aria-hidden>
                      <div className={`h-1.5 rounded-full ${key === "declined" ? "bg-danger" : key === "pending" ? "bg-warning" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </dl>
            <p className="mt-2 text-xs text-muted">{t("dashboard.rsvpHelp")}</p>
          </>
        ) : (
          <p className="text-sm text-muted">{t("dashboard.noInvites")}</p>
        )}
      </Card>

      <Card>
        <CardTitle action={<Link href={`${base}/rsvp`} className="text-sm text-primary" aria-label={t("rsvp.headcountTitle")}>→</Link>}>
          {t("dashboard.headcountCard")}
        </CardTitle>
        {invitedFns.length > 0 ? (
          <ul className="divide-y divide-border">
            {invitedFns.map((f) => {
              const h = heads.get(f.id)!;
              return (
                <li key={f.id}>
                  <Link href={ctx.can("rsvp.edit") ? `${base}/rsvp/${f.id}` : `${base}/rsvp#fn-${f.id}`} className="flex min-h-11 flex-col justify-center py-1 hover:text-primary">
                    <span className="font-medium">{f.name}</span>
                    <span className="text-sm text-muted">{t("dashboard.headcountRow", { attending: h.attending, maybe: h.maybe, invited: h.invited })}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("dashboard.noInvites")}</p>
        )}
      </Card>

      <Card>
        <CardTitle
          action={
            <Link href={`${base}/logistics/arrivals?date=${today}`} className="text-sm text-primary" aria-label={t("dashboard.arrivalsCard")}>
              →
            </Link>
          }
        >
          {t("dashboard.arrivalsCard")}
        </CardTitle>
        {arriving.length > 0 ? (
          <>
            <p className="text-2xl font-semibold">{arriving.length}</p>
            <p className={`text-sm ${needPickup.length > onRun ? "text-danger" : "text-muted"}`}>
              {t("dashboard.arrivalsSummary", { pickup: needPickup.length, assigned: onRun })}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted">{t("dashboard.noArrivals")}</p>
        )}
      </Card>
    </div>
  );
}
