import Link from "next/link";
import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { listQuoteRequests } from "@/lib/quotes";
import { listServices } from "@/lib/services";
import { getEventContext } from "@/lib/server/event-context";
import { serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

export default async function RequestsPage({ params, searchParams }: PageProps<"/events/[eventId]/vendors/requests">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const [requests, services] = await Promise.all([listQuoteRequests(getDb(), eventId), listServices(getDb(), eventId)]);
  const svcName = (id: string) => {
    const s = services.find((x) => x.id === id);
    return s ? serviceLabel(t, s) : "";
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("vendors.requests")}
        action={ctx.can("vendors.edit") ? <LinkButton href={`/events/${eventId}/vendors/requests/new`}>{t("quotes.newRequest")}</LinkButton> : undefined}
      />
      {sp.created && <Alert tone="success">{t("quotes.created")}</Alert>}
      <Card>
        {requests.length === 0 ? (
          <p className="text-muted">{t("quotes.noRequests")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {requests.map((r) => (
              <li key={r.request.id}>
                <Link href={`/events/${eventId}/vendors/requests/${r.request.id}`} className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:text-primary">
                  <span className="font-medium">{r.vendorName}</span>
                  <Badge tone={r.request.closedAt ? "neutral" : "primary"}>{r.request.closedAt ? t("quotes.closed") : t("quotes.open")}</Badge>
                  <span className="text-sm text-muted">{[...new Set(r.serviceIds.map(svcName))].join(", ")}</span>
                  {r.request.dueDate && <span className="text-sm text-muted">{t("quotes.dueDate")}: {formatDay(locale, r.request.dueDate)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
