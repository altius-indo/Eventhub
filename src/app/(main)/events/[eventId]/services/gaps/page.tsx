import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { gapView } from "@/lib/services";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, statusTone } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

/** SVC-07: everything not fully booked yet, soonest function and must-haves first. */
export default async function GapsPage({ params }: PageProps<"/events/[eventId]/services/gaps">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const gaps = await gapView(getDb(), eventId, eventToday(ctx.event.timezone));
  const days = (d: number | null) => (d == null ? t("services.noDate") : d === 0 ? t("services.dayToday") : d > 0 ? t("services.daysLeft", { days: d }) : t("services.daysPast", { days: -d }));
  return (
    <div className="space-y-4">
      <PageHeader title={t("services.gapTitle")} />
      <Card>
        {gaps.length === 0 ? (
          <p className="text-muted">{t("services.gapEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {gaps.map((g) => (
              <li key={g.requirement.id} className="py-2">
                <Link href={`/events/${eventId}/services/${g.serviceId}`} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 hover:text-primary">
                  <span className="font-medium">{g.requirement.title}</span>
                  <span className="text-sm text-muted">
                    {g.functionName} · {g.serviceName}
                  </span>
                  <Badge tone={statusTone[g.status]}>{t(`services.status.${g.status}` as MessageKey)}</Badge>
                  {g.requirement.priority === "must" ? <Badge tone="danger">{t("services.priorities.must")}</Badge> : <Badge>{t("services.priorities.nice")}</Badge>}
                  {g.requirement.quantity != null && g.coverage && g.coverage.confirmedQty > 0 && (
                    <span className="text-sm">{t("services.coverage", { covered: g.coverage.confirmedQty, quantity: g.requirement.quantity })}</span>
                  )}
                  {g.requirement.estimatePaise != null && <span className="text-sm text-muted">{formatInr(locale, g.requirement.estimatePaise)}</span>}
                  <span className={`text-sm ${g.daysLeft != null && g.daysLeft <= 14 ? "font-medium text-danger" : "text-muted"}`}>
                    {days(g.daysLeft)}
                    {g.functionDate && ` · ${formatDay(locale, g.functionDate)}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
