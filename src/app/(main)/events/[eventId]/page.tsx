import Link from "next/link";
import { getDb } from "@/db";
import { Card, CardTitle, LinkButton } from "@/components/ui";
import type { MessageKey } from "@/i18n/core";
import { countPendingApprovals } from "@/lib/approvals";
import { memberCounts } from "@/lib/events";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Whole days from today (in the event's timezone) to an ISO date. */
function daysUntil(isoDate: string, timeZone: string): number {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  return Math.round((Date.parse(isoDate) - Date.parse(today)) / 86_400_000);
}

const upcoming: MessageKey[] = [
  "dashboard.modules.guests",
  "dashboard.modules.itinerary",
  "dashboard.modules.services",
  "dashboard.modules.budget",
  "dashboard.modules.messaging",
  "dashboard.modules.website",
];

export default async function EventDashboard({ params }: PageProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const db = getDb();
  const counts = await memberCounts(db, eventId);
  const pending = (await countPendingApprovals(db, [eventId])).get(eventId) ?? 0;
  const { event } = ctx;

  let countdown = t("dashboard.noDate");
  if (event.startDate) {
    const days = daysUntil(event.startDate, event.timezone);
    const endDays = event.endDate ? daysUntil(event.endDate, event.timezone) : days;
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
        <CardTitle action={<Link href={`/events/${eventId}/members`} className="text-sm text-primary">→</Link>}>
          {t("dashboard.team")}
        </CardTitle>
        <p>{t("dashboard.teamSummary", { hosts: counts.hosts, planners: counts.planners })}</p>
        {counts.invites > 0 && <p className="mt-1 text-sm text-muted">{t("dashboard.pendingInvites", { count: counts.invites })}</p>}
      </Card>

      <Card>
        <CardTitle>{t("dashboard.waitingApproval")}</CardTitle>
        <p className="text-3xl font-semibold">{pending}</p>
        {pending > 0 && (
          <LinkButton href={`/events/${eventId}/approvals`} variant="secondary" className="mt-3">
            {t("dashboard.viewApprovals")}
          </LinkButton>
        )}
      </Card>

      <Card className="sm:col-span-2 lg:col-span-3">
        <CardTitle>{t("dashboard.comingNext")}</CardTitle>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
