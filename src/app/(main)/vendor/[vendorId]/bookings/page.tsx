import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr } from "@/i18n/core";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { listPortalBookings } from "@/lib/vendor-portal";

const bookingTone = { awaiting_confirmation: "warning", confirmed: "success", cancelled: "neutral" } as const;

export default async function PortalBookings({ params }: PageProps<"/vendor/[vendorId]/bookings">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  const { t, locale } = await getTranslator();
  const rows = await listPortalBookings(getDb(), ctx.event.id, vendorId);
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">{t("vendorPortal.bookings.empty")}</p>
      </Card>
    );
  }
  return (
    <ul className="space-y-3">
      {rows.map((b) => (
        <li key={b.id}>
          <Link href={`/vendor/${vendorId}/bookings/${b.id}`} className="block min-h-11 rounded-xl border border-border bg-surface p-4 hover:bg-surface-muted">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{formatInr(locale, b.total)}</span>
              <Badge tone={bookingTone[b.status]}>{t(`vendorPortal.bookingStatus.${b.status}`)}</Badge>
            </p>
            <p className="mt-1 text-sm text-muted">{b.functions.map((f) => [f.functionName, f.functionDate && formatDay(locale, f.functionDate)].filter(Boolean).join(" · ")).join(", ")}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
