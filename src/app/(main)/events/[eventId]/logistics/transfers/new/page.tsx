import { inArray, and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { RunFields } from "@/components/run-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { guests, guestTravel } from "@/db/schema";
import { listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { runFieldLabels } from "@/lib/server/m4-labels";
import { getTranslator } from "@/lib/server/session";
import { createRunAction } from "../../actions";

/** New run; when opened from the arrivals board, prefilled from the selected guests' travel. */
export default async function NewRunPage({ params, searchParams }: PageProps<"/events/[eventId]/logistics/transfers/new">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("travel.edit")) notFound();
  const { t } = await getTranslator();
  const db = getDb();
  const ids = (typeof sp.guests === "string" ? sp.guests.split(",") : []).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100);
  const kind = sp.kind === "drop" ? "drop" : "pickup";
  const selected = ids.length
    ? await db
        .select({ guest: guests, travel: guestTravel })
        .from(guests)
        .leftJoin(guestTravel, eq(guestTravel.guestId, guests.id))
        .where(and(eq(guests.eventId, eventId), inArray(guests.id, ids)))
    : [];
  const times = selected.map((s) => (kind === "pickup" ? s.travel?.arrivalAt : s.travel?.departureAt)).filter((d): d is Date => !!d);
  const point = selected.map((s) => (kind === "pickup" ? s.travel?.arrivalPoint : s.travel?.departurePoint)).find(Boolean) ?? "";
  const departsAt = times.length ? (kind === "pickup" ? new Date(Math.max(...times.map((d) => d.getTime()))) : new Date(Math.min(...times.map((d) => d.getTime())) - 3 * 3600_000)) : undefined;

  return (
    <div className="max-w-2xl">
      <PageHeader title={t("transfers.add")} subtitle={selected.length ? selected.map((s) => s.guest.name).join(", ") : undefined} />
      <Card>
        <SimpleForm action={createRunAction.bind(null, eventId)}>
          {selected.map((s) => (
            <input key={s.guest.id} type="hidden" name="guestIds" value={s.guest.id} />
          ))}
          <RunFields
            labels={runFieldLabels(t)}
            functions={await listFunctions(db, eventId)}
            run={{ kind, departsAt, fromPlace: kind === "pickup" ? point : "", toPlace: kind === "drop" ? point : "", capacity: Math.max(4, selected.length) }}
          />
          <SubmitButton>{t("transfers.add")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
