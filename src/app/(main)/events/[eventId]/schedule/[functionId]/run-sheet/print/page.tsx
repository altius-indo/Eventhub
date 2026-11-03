import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { getDb } from "@/db";
import { formatDateTime, formatDay, formatWallClock } from "@/i18n/core";
import { getFunction, NotFoundError } from "@/lib/functions";
import { formatPhone } from "@/lib/guests";
import { listItems } from "@/lib/runsheet";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { isUuid } from "@/lib/ids";

export default async function RunSheetPrint({ params }: PageProps<"/events/[eventId]/schedule/[functionId]/run-sheet/print">) {
  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(functionId)) notFound();
  const db = getDb();
  const fn = await getFunction(db, eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const rows = await listItems(db, eventId, functionId);
  const { t, locale } = await getTranslator();
  return (
    <article className="print-sheet mx-auto max-w-3xl bg-white p-6 text-black">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">{ctx.event.name}</p>
          <h1 className="text-2xl font-semibold">{t("runsheet.forFunction", { name: fn.name })}</h1>
          <p className="text-sm">{[fn.date && formatDay(locale, fn.date, { dateStyle: "full" }), fn.venueName].filter(Boolean).join(" · ")}</p>
        </div>
        <PrintButton label={t("logistics.print")} />
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-black text-left">
            <th className="py-1 pr-2">{t("runsheet.startsAt")}</th>
            <th className="py-1 pr-2">{t("runsheet.itemTitle")}</th>
            <th className="py-1 pr-2">{t("runsheet.owner")}</th>
            <th className="py-1">{t("runsheet.location")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, ownerUserName, ownerVendorName }) => (
            <tr key={item.id} className="border-b border-gray-300 align-top" style={{ breakInside: "avoid" }}>
              <td className="py-1 pr-2 tabular-nums">
                {formatWallClock(locale, item.startsAt, { timeStyle: "short" })}
                {item.durationMin ? ` (${item.durationMin}′)` : ""}
                {item.timeLocked ? " 🔒" : ""}
              </td>
              <td className="py-1 pr-2">
                <strong>{item.title}</strong>
                {item.notes && <div className="whitespace-pre-line text-xs">{item.notes}</div>}
              </td>
              <td className="py-1 pr-2">{[ownerUserName, ownerVendorName, item.ownerName, formatPhone(item.ownerPhone)].filter(Boolean).join(" · ")}</td>
              <td className="py-1">{item.location}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-xs">{t("logistics.printedAt", { time: formatDateTime(locale, new Date()) })}</p>
    </article>
  );
}
