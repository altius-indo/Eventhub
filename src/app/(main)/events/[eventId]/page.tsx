import Link from "next/link";
import { getDb } from "@/db";
import { Card, CardTitle, LinkButton } from "@/components/ui";
import { formatDay, formatInrShort, formatTime, type MessageKey } from "@/i18n/core";
import { budgetFacts, sumFacts } from "@/lib/budget";
import { payables } from "@/lib/payments";
import { gapView } from "@/lib/services";
import { countPendingApprovals } from "@/lib/approvals";
import { memberCounts } from "@/lib/events";
import { invitedCounts, listFunctions } from "@/lib/functions";
import { guestStats } from "@/lib/guests";
import { taskSummary, todayIn } from "@/lib/tasks";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Whole days from today (in the event's timezone) to an ISO date. */
function daysUntil(isoDate: string, today: string): number {
  return Math.round((Date.parse(isoDate) - Date.parse(today)) / 86_400_000);
}

const upcoming: MessageKey[] = ["dashboard.modules.messaging"];

export default async function EventDashboard({ params }: PageProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const { event } = ctx;
  const today = todayIn(event.timezone);
  const [counts, pendingMap, stats, fns, invited, tasks, facts, due, gaps] = await Promise.all([
    memberCounts(db, eventId),
    countPendingApprovals(db, [eventId]),
    guestStats(db, eventId),
    listFunctions(db, eventId),
    invitedCounts(db, eventId),
    taskSummary(db, eventId, today),
    budgetFacts(db, eventId),
    payables(db, eventId, today, new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)),
    gapView(db, eventId, today),
  ]);
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
          <>
            <p className="font-medium">{next.name}</p>
            <p className="text-sm text-muted">
              {[formatDay(locale, next.date!, { weekday: "short", day: "numeric", month: "short" }), next.startTime && formatTime(locale, next.startTime), next.venueName]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mt-1 text-sm text-muted">
              {t("schedule.invitedCount", { guests: invited.get(next.id)?.guests ?? 0, households: invited.get(next.id)?.households ?? 0 })}
            </p>
          </>
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

      <Card className="sm:col-span-2 lg:col-span-1">
        <CardTitle>{t("dashboard.comingNext")}</CardTitle>
        <ul className="grid gap-2">
          {upcoming.map((key) => (
            <li key={key} className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted">
              {t(key)}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
