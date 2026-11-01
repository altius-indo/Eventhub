import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { getFunction, NotFoundError } from "@/lib/functions";
import { seatingPlan } from "@/lib/seating";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function SeatingPrint({ params }: PageProps<"/events/[eventId]/schedule/[functionId]/seating/print">) {
  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!/^[0-9a-f-]{36}$/i.test(functionId)) notFound();
  const db = getDb();
  const fn = await getFunction(db, eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const plan = await seatingPlan(db, eventId, functionId);
  const { t, locale } = await getTranslator();
  return (
    <article className="print-sheet mx-auto max-w-4xl bg-white p-6 text-black">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">{ctx.event.name}</p>
          <h1 className="text-2xl font-semibold">{t("seating.forFunction", { name: fn.name })}</h1>
        </div>
        <PrintButton label={t("logistics.print")} />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {plan.tables.map((tb) => (
          <section key={tb.id} className="rounded border border-gray-400 p-2" style={{ breakInside: "avoid" }}>
            <h2 className="font-semibold">
              {tb.name} <span className="text-xs font-normal">({tb.seatsUsed}/{tb.capacity})</span>
            </h2>
            <ol className="list-decimal pl-5 text-sm">
              {tb.guests.map((g) => (
                <li key={g.id}>{g.name}</li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs">{t("logistics.printedAt", { time: formatDateTime(locale, new Date()) })}</p>
    </article>
  );
}
