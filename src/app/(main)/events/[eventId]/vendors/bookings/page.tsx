import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatInr } from "@/i18n/core";
import { listBookings } from "@/lib/bookings";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function BookingsPage({ params }: PageProps<"/events/[eventId]/vendors/bookings">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const rows = await listBookings(getDb(), eventId, { includeCancelled: true });
  return (
    <div className="space-y-4">
      <PageHeader title={t("vendors.bookings")} />
      <Card>
        {rows.length === 0 ? (
          <p className="text-muted">{t("bookings.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((b) => (
              <li key={b.booking.id}>
                <Link href={`/events/${eventId}/vendors/bookings/${b.booking.id}`} className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:text-primary">
                  <span className="font-medium">{b.vendorName}</span>
                  <span>{formatInr(locale, b.booking.subtotalPaise + b.booking.gstPaise)}</span>
                  <Badge tone={b.booking.status === "confirmed" ? "success" : b.booking.status === "cancelled" ? "neutral" : "warning"}>{t(`bookings.status.${b.booking.status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
