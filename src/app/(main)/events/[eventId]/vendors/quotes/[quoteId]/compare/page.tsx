import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatInr } from "@/i18n/core";
import { isUuid } from "@/lib/ids";
import { comparePackage, QuoteError } from "@/lib/quotes";
import { getEventContext } from "@/lib/server/event-context";
import { serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

/** VND-05 per package: quotes side by side per service, and the cheapest separate quotes. */
export default async function ComparePage({ params }: PageProps<"/events/[eventId]/vendors/quotes/[quoteId]/compare">) {
  const { eventId, quoteId } = await params;
  await getEventContext(eventId);
  if (!isUuid(quoteId)) notFound();
  const { t, locale } = await getTranslator();
  const c = await comparePackage(getDb(), eventId, quoteId).catch((e) => {
    if (e instanceof QuoteError) notFound();
    throw e;
  });
  const inr = (p: number | null) => (p == null ? "—" : formatInr(locale, p));
  return (
    <div className="space-y-4">
      <PageHeader title={t("quotes.compareTitle")} />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium" />
                {c.columns.map((col) => (
                  <th key={col.quote.id} className="py-2 pr-3 text-right font-medium">
                    <Link href={`/events/${eventId}/vendors/quotes/${col.quote.id}`} className="text-primary underline">
                      {col.vendorName}
                    </Link>
                  </th>
                ))}
                <th className="py-2 pr-3 text-right font-medium">{t("quotes.bestIndividual")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {c.base.services.map((s, i) => (
                <tr key={s.id}>
                  <td className="py-2 pr-3">
                    {s.functionName} · {serviceLabel(t, s)}
                  </td>
                  {c.columns.map((col) => (
                    <td key={col.quote.id} className="py-2 pr-3 text-right">
                      {col.perService[i] == null ? <span className="text-warning">{t("services.notCovered")}</span> : inr(col.perService[i])}
                    </td>
                  ))}
                  <td className="py-2 pr-3 text-right">
                    {c.best[i].total == null ? (
                      <span className="text-muted">{t("quotes.noSingle")}</span>
                    ) : (
                      <>
                        {inr(c.best[i].total)}
                        <div className="text-xs text-muted">{c.best[i].vendorName}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2 pr-3">{t("quotes.total")}</td>
                {c.columns.map((col) => (
                  <td key={col.quote.id} className="py-2 pr-3 text-right">
                    {inr(col.total)}
                  </td>
                ))}
                <td className="py-2 pr-3 text-right">{inr(c.bestTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {c.uncovered.length > 0 && <p className="mt-2 text-sm text-muted">{t("quotes.uncovered", { count: c.uncovered.length })}</p>}
      </Card>
    </div>
  );
}
