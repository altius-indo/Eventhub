import { count, desc, eq, ilike } from "drizzle-orm";
import { Badge, Card, Input, LinkButton } from "@/components/ui";
import { getDb } from "@/db";
import { eventMembers, events } from "@/db/schema";
import { formatDate } from "@/i18n/core";
import { getTranslator, requireAppAdmin } from "@/lib/server/session";

export default async function AdminEventsPage({ searchParams }: PageProps<"/admin/events">) {
  await requireAppAdmin();
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const { t, locale } = await getTranslator();
  const rows = await getDb()
    .select({ event: events, members: count(eventMembers.id) })
    .from(events)
    .leftJoin(eventMembers, eq(eventMembers.eventId, events.id))
    .where(query ? ilike(events.name, `%${query.replace(/[%_]/g, "\\$&")}%`) : undefined)
    .groupBy(events.id)
    .orderBy(desc(events.createdAt))
    .limit(100);

  return (
    <div className="space-y-4">
      <form className="flex gap-2" role="search">
        <Input name="q" defaultValue={query} aria-label={t("admin.events")} />
        <button type="submit" className="min-h-11 rounded-lg border border-border bg-surface px-4 text-sm">
          {t("admin.searchButton")}
        </button>
      </form>
      <Card>
        {rows.length === 0 ? (
          <p className="text-muted">{t("admin.noResults")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ event, members }) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {event.name}
                    {event.deletedAt && <Badge tone="danger">{t("admin.deletedBadge")}</Badge>}
                  </p>
                  <p className="text-sm text-muted">
                    {t("admin.memberCount", { count: members })} · {t("admin.createdOn", { date: formatDate(locale, event.createdAt) })}
                  </p>
                </div>
                {!event.deletedAt && (
                  <LinkButton href={`/events/${event.id}`} variant="secondary" className="min-h-10">
                    {t("admin.open")}
                  </LinkButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
