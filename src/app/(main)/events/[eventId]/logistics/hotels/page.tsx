import Link from "next/link";
import { HotelFields } from "@/components/hotel-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { listHotels } from "@/lib/hotels";
import { getEventContext } from "@/lib/server/event-context";
import { hotelLabels } from "@/lib/server/m4-labels";
import { getTranslator } from "@/lib/server/session";
import { createHotelAction } from "./actions";

export default async function HotelsPage({ params }: PageProps<"/events/[eventId]/logistics/hotels">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const rows = await listHotels(getDb(), eventId);
  return (
    <div className="space-y-4">
      <PageHeader title={t("hotels.title")} />
      {rows.length === 0 ? (
        <Card>
          <p className="text-muted">{t("hotels.empty")}</p>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {rows.map(({ hotel, blocked, roomsUsed, guests }) => (
            <li key={hotel.id}>
              <Link href={`/events/${eventId}/logistics/hotels/${hotel.id}`} className="block rounded-xl border border-border bg-surface p-4 hover:border-primary">
                <p className="font-semibold">{hotel.name}</p>
                <p className="text-sm text-muted">{t("hotels.summary", { used: roomsUsed, blocked, guests })}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {ctx.can("travel.edit") && (
        <Card>
          <CardTitle>{t("hotels.add")}</CardTitle>
          <SimpleForm action={createHotelAction.bind(null, eventId)}>
            <HotelFields labels={hotelLabels(t)} />
            <SubmitButton>{t("hotels.add")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
