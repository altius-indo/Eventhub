import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { getDb } from "@/db";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { addressLabels, trackerFilterKeys, type TrackerFilters } from "@/lib/thank-yous";

/** Printed thank-you cards (GFT-09): address labels for A4 printing / Save as PDF (ADR-0015). */
export default async function LabelsPage({ params, searchParams }: PageProps<"/events/[eventId]/gifts/thank-yous/labels">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage")) notFound();
  const { t } = await getTranslator();
  const filters: TrackerFilters = {};
  for (const k of trackerFilterKeys) if (typeof sp[k] === "string" && sp[k]) filters[k] = String(sp[k]).slice(0, 60);
  const rows = await addressLabels(getDb(), dctx(ctx), filters);
  const withAddress = rows.filter((r) => r.address || r.city || r.postalCode);
  const qs = new URLSearchParams(filters as Record<string, string>).toString();
  return (
    <article className="print-sheet mx-auto max-w-4xl bg-white p-6 text-black">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-xl font-semibold">{t("thankYous.labels")}</h1>
          <p className="text-sm">{t("thankYous.labelsHelp", { count: withAddress.length, missing: rows.length - withAddress.length })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/events/${eventId}/gifts/thank-yous/labels/export${qs ? `?${qs}` : ""}`} className="inline-flex min-h-11 items-center rounded-lg border border-gray-400 px-4 text-sm">
            {t("thankYous.labelsExcel")}
          </a>
          <PrintButton label={t("logistics.print")} />
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 print:grid-cols-3">
        {withAddress.map((r) => (
          <li key={r.id} className="rounded border border-gray-300 p-3 text-sm" style={{ breakInside: "avoid" }}>
            <p className="font-semibold">{r.name}</p>
            {r.address && <p className="whitespace-pre-line">{r.address}</p>}
            <p>{[r.city, r.postalCode].filter(Boolean).join(" ")}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}
