import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { getDb } from "@/db";
import { formatDate, formatDateTime, formatDay } from "@/i18n/core";
import { getCatererView, HeadcountError } from "@/lib/caterer-headcount";
import { isUuid } from "@/lib/ids";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { headcountRows } from "../../summary";

/** Printable headcount summary for the caterer (RSV-06 export, ADR-0015: print to PDF from the browser). */
export default async function HeadcountPrint({ params }: PageProps<"/vendor/[vendorId]/headcount/[functionId]/print">) {
  const { vendorId, functionId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.headcount") || !isUuid(functionId)) notFound();
  const { t, locale } = await getTranslator();
  const view = await getCatererView(getDb(), ctx.event.id, vendorId, functionId).catch((e) => {
    if (e instanceof HeadcountError) notFound();
    throw e;
  });
  const rows = headcountRows(t, view);
  const when = (d: Date) => formatDate(locale, d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.event.timezone });
  return (
    <article className="print-sheet mx-auto max-w-2xl bg-white p-6 text-black">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">
            {ctx.event.name} · {ctx.vendor.name}
          </p>
          <h1 className="text-2xl font-semibold">
            {t("headcount.title")} · {view.functionName}
          </h1>
          {view.functionDate && <p className="text-sm">{formatDay(locale, view.functionDate, { dateStyle: "full" })}</p>}
          {view.frozen && view.lockAt && <p className="text-sm font-medium">{view.releasedAt ? t("headcount.releasedAt", { time: when(view.releasedAt) }) : t("headcount.lockedAt", { time: when(view.lockAt) })}</p>}
        </div>
        <PrintButton label={t("logistics.print")} />
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-black text-left">
            <th className="py-1 pr-2">{t("headcount.item")}</th>
            <th className="py-1 text-right">{t("headcount.count")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-gray-300">
              <td className="py-1 pr-2">
                <span className="text-xs">{r.group} · </span>
                {r.label}
              </td>
              <td className="py-1 text-right tabular-nums">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.share && <p className="mt-3 text-sm">{t("headcount.share", { quantity: view.share.quantity, of: view.share.of })}</p>}
      <p className="mt-2 text-xs">{t("headcount.aggregateHelp")}</p>
      <p className="mt-2 text-xs">{t("headcount.printedAt", { time: formatDateTime(locale, new Date()) })}</p>
    </article>
  );
}
