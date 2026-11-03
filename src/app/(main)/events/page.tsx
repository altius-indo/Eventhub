import Link from "next/link";
import { getDb } from "@/db";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { formatDate } from "@/i18n/core";
import { countPendingApprovals } from "@/lib/approvals";
import { acceptPendingInvitations } from "@/lib/auth-core";
import { listEventsForUser } from "@/lib/events";
import { getTranslator, requireUser } from "@/lib/server/session";
import { restoreEventAction } from "./actions";

export default async function EventsPage() {
  const { user } = await requireUser();
  const { t, locale } = await getTranslator();
  const db = getDb();
  // Picks up invitations sent to an identifier the user added after logging in.
  await acceptPendingInvitations(db, user.id);
  const { active, deleted } = await listEventsForUser(db, user.id);
  const pending = await countPendingApprovals(
    db,
    active.filter((r) => r.role === "host").map((r) => r.event.id),
  );

  return (
    <div>
      <PageHeader title={t("events.title")} action={<LinkButton href="/events/new">{t("events.create")}</LinkButton>} />
      {active.length === 0 ? (
        <Card>
          <p className="text-muted">{t("events.empty")}</p>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {active.map(({ event, role }) => (
            <li key={event.id}>
              <Link href={`/events/${event.id}`} className="block rounded-xl border border-border bg-surface p-4 hover:border-primary">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold">{event.name}</h2>
                  <Badge tone={role === "host" ? "primary" : "neutral"}>{t(`roles.${role}`)}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {[event.coupleNames, event.city, event.startDate && formatDate(locale, event.startDate)].filter(Boolean).join(" · ")}
                </p>
                {(pending.get(event.id) ?? 0) > 0 && (
                  <p className="mt-2">
                    <Badge tone="warning">
                      {t("dashboard.waitingApproval")}: {pending.get(event.id)}
                    </Badge>
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {deleted.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-muted">{t("events.deleted")}</h2>
          <ul className="space-y-2">
            {deleted.map(({ event }) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-4 py-3">
                <div>
                  <p className="font-medium">{event.name}</p>
                  <p className="text-sm text-muted">{t("events.restoreUntil", { date: formatDate(locale, event.purgeAfter!) })}</p>
                </div>
                <form action={restoreEventAction}>
                  <input type="hidden" name="eventId" value={event.id} />
                  <button type="submit" className="min-h-11 rounded-lg px-3 text-sm font-medium text-primary hover:bg-primary-soft">
                    {t("common.restore")}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
