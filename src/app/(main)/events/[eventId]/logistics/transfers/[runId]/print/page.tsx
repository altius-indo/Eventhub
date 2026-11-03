import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { getDb } from "@/db";
import { formatDateTime, formatWallClock } from "@/i18n/core";
import { formatPhone } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { getManifest, getRun, TransferError } from "@/lib/transfers";
import { isUuid } from "@/lib/ids";

/** Driver manifest, laid out for A4 printing / Save as PDF (ITN-07, ADR-0015). */
export default async function RunPrintPage({ params }: PageProps<"/events/[eventId]/logistics/transfers/[runId]/print">) {
  const { eventId, runId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(runId)) notFound();
  const db = getDb();
  const run = await getRun(db, eventId, runId).catch((e) => {
    if (e instanceof TransferError) notFound();
    throw e;
  });
  const rows = await getManifest(db, eventId, runId);
  const { t, locale } = await getTranslator();
  const fmt = (d: Date) => formatWallClock(locale, d, { dateStyle: "medium", timeStyle: "short" });
  return (
    <article className="print-sheet mx-auto max-w-3xl bg-white p-6 text-black">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">{ctx.event.name}</p>
          <h1 className="text-2xl font-semibold">
            {t(`transfers.kinds.${run.kind}`)}: {run.fromPlace} → {run.toPlace}
          </h1>
          <p>{fmt(run.departsAt)}</p>
          <p className="text-sm">{[run.vehicle, run.driverName, formatPhone(run.driverPhone)].filter(Boolean).join(" · ")}</p>
        </div>
        <PrintButton label={t("logistics.print")} />
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-black text-left">
            <th className="py-1 pr-2">#</th>
            <th className="py-1 pr-2">{t("importer.fields.name")}</th>
            <th className="py-1 pr-2">{t("importer.fields.household")}</th>
            <th className="py-1 pr-2">{t("transfers.flight")}</th>
            <th className="py-1">{t("transfers.contact")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const at = run.kind === "pickup" ? r.travel?.arrivalAt : r.travel?.departureAt;
            const num = run.kind === "pickup" ? r.travel?.arrivalNumber : r.travel?.departureNumber;
            return (
              <tr key={r.guest.id} className="border-b border-gray-300 align-top" style={{ breakInside: "avoid" }}>
                <td className="py-1 pr-2">{i + 1}</td>
                <td className="py-1 pr-2">{r.guest.name}</td>
                <td className="py-1 pr-2">{r.household.name}</td>
                <td className="py-1 pr-2">{[num, at && fmt(at)].filter(Boolean).join(" · ")}</td>
                <td className="py-1">{formatPhone(r.contactPhone)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-4 text-xs">
        {t("transfers.seats", { used: rows.length, capacity: run.capacity })} · {t("logistics.printedAt", { time: formatDateTime(locale, new Date()) })}
      </p>
    </article>
  );
}
