import Link from "next/link";
import { Badge, Card, CardTitle } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatWallClock } from "@/i18n/core";
import { catererFunctions } from "@/lib/caterer-headcount";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { listPortalDocuments, portalOverview, portalRunSheet } from "@/lib/vendor-portal";
import { PortalDocuments } from "./portal-documents";

export default async function VendorOverview({ params }: PageProps<"/vendor/[vendorId]">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const eventId = ctx.event.id;
  const [counts, items, catering, docs] = await Promise.all([
    portalOverview(db, eventId, vendorId),
    portalRunSheet(db, eventId, vendorId),
    catererFunctions(db, eventId, vendorId),
    listPortalDocuments(db, eventId, vendorId),
  ]);
  const base = `/vendor/${vendorId}`;
  const stats = [
    { label: t("vendorPortal.overview.openRequests"), value: counts.openRequests, href: `${base}/requests` },
    { label: t("vendorPortal.overview.awaiting"), value: counts.awaiting, href: `${base}/bookings` },
    { label: t("vendorPortal.overview.confirmed"), value: counts.confirmed, href: `${base}/bookings` },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="flex min-h-11 flex-col rounded-xl border border-border bg-surface p-3 text-center hover:bg-surface-muted">
            <span className="text-2xl font-semibold">{s.value}</span>
            <span className="text-xs text-muted">{s.label}</span>
          </Link>
        ))}
      </div>

      {catering.length > 0 && (
        <Card>
          <CardTitle>{t("vendorPortal.overview.headcountTitle")}</CardTitle>
          <ul className="divide-y divide-border text-sm">
            {catering.map((f) => (
              <li key={f.functionId}>
                <Link href={`${base}/headcount/${f.functionId}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                  {f.functionName}
                  {f.functionDate && <span className="text-muted">{formatDay(locale, f.functionDate)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardTitle>{t("vendorPortal.overview.runSheet")}</CardTitle>
        {items.length === 0 ? (
          <p className="text-sm text-muted">{t("vendorPortal.overview.noRunSheet")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {items.map((i) => (
              <li key={i.id} className="py-2">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="tabular-nums">{formatWallClock(locale, i.startsAt)}</span>
                  <span className="font-medium">{i.title}</span>
                  <Badge>{i.functionName}</Badge>
                </p>
                {(i.location || i.notes) && <p className="whitespace-pre-line text-muted">{[i.location, i.notes].filter(Boolean).join(" · ")}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {docs.length > 0 && <PortalDocuments vendorId={vendorId} docs={docs} title={t("vendorPortal.bookings.documents")} t={t} />}
    </div>
  );
}
