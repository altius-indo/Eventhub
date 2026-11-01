import Link from "next/link";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { listInvoices } from "@/lib/payments";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, payTone } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

export default async function InvoicesPage({ params }: PageProps<"/events/[eventId]/budget/invoices">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const rows = await listInvoices(getDb(), eventId, eventToday(ctx.event.timezone));
  return (
    <div className="space-y-4">
      <PageHeader title={t("invoices.title")} action={ctx.can("invoices.edit") ? <LinkButton href={`/events/${eventId}/budget/invoices/new`}>{t("invoices.add")}</LinkButton> : undefined} />
      <Card>
        {rows.length === 0 ? (
          <p className="text-muted">{t("invoices.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.invoice.id}>
                <Link href={`/events/${eventId}/budget/invoices/${r.invoice.id}`} className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:text-primary">
                  <span className="font-medium">{r.vendorName}</span>
                  <span className="text-sm text-muted">
                    {r.invoice.number} · {formatDay(locale, r.invoice.invoiceDate)}
                  </span>
                  <span className="ml-auto">{formatInr(locale, r.invoice.totalPaise)}</span>
                  <Badge tone={payTone[r.status]}>{t(`payments.status.${r.status}` as MessageKey)}</Badge>
                  {r.mismatch && <Badge tone="warning">!</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
