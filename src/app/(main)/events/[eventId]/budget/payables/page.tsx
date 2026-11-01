import Link from "next/link";
import { PrintButton } from "@/components/print-button";
import { Badge, Card, CardTitle, PageHeader, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { payables } from "@/lib/payments";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, payerText, payTone, periodEnd } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

/** PAY-06: what's due this week or month (and anything overdue), by payer and vendor. */
export default async function PayablesPage({ params, searchParams }: PageProps<"/events/[eventId]/budget/payables">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const period = sp.period === "week" || sp.period === "all" ? sp.period : "month";
  const today = eventToday(ctx.event.timezone);
  const rows = await payables(getDb(), eventId, today, periodEnd(today, period));
  const inr = (p: number) => formatInr(locale, p);
  const sum = (key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.remaining);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const base = `/events/${eventId}/budget/payables`;
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("payments.payablesTitle")}
        action={
          <div className="flex flex-wrap gap-2 print:hidden">
            <a href={`${base}/export?period=${period}`} className={buttonClass("secondary")}>
              {t("payments.export")}
            </a>
            <PrintButton label={t("payments.print")} />
          </div>
        }
      />
      <nav className="flex flex-wrap gap-2 text-sm print:hidden">
        {(["week", "month", "all"] as const).map((p) => (
          <Link key={p} href={`${base}?period=${p}`} aria-current={p === period ? "page" : undefined} className={`inline-flex min-h-10 items-center rounded-full border px-4 ${p === period ? "border-primary bg-primary-soft text-primary" : "border-border bg-surface"}`}>
            {t(p === "week" ? "payments.thisWeek" : p === "month" ? "payments.thisMonth" : "payments.all")}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <Card>
          <p className="text-muted">{t("payments.noPayables")}</p>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardTitle>{t("payments.byPayer")}</CardTitle>
              <ul className="space-y-1 text-sm">
                {sum((r) => payerText(t, locale, r.payer)).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span>{k}</span>
                    <span className="font-medium">{inr(v)}</span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <CardTitle>{t("payments.byVendor")}</CardTitle>
              <ul className="space-y-1 text-sm">
                {sum((r) => r.vendorName).map(([k, v]) => (
                  <li key={k} className="flex justify-between gap-2">
                    <span>{k}</span>
                    <span className="font-medium">{inr(v)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
          <Card>
            <ul className="divide-y divide-border text-sm">
              {rows.map((r) => (
                <li key={r.milestoneId}>
                  <Link href={`/events/${eventId}/vendors/bookings/${r.bookingId}`} className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:text-primary">
                    <span className="font-medium">{r.vendorName}</span>
                    <span className="text-muted">{r.label || t(`bookings.milestoneKinds.${r.kind}`)}</span>
                    {r.dueDate && <span className="text-muted">{formatDay(locale, r.dueDate)}</span>}
                    <span className="ml-auto font-medium">{inr(r.remaining)}</span>
                    <Badge tone={payTone[r.status]}>{t(`payments.status.${r.status}` as MessageKey)}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
