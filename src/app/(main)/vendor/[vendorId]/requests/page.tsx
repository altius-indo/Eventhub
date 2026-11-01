import Link from "next/link";
import { Badge, Card } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { listPortalRequests } from "@/lib/vendor-portal";

export default async function PortalRequests({ params }: PageProps<"/vendor/[vendorId]/requests">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  const { t, locale } = await getTranslator();
  const rows = await listPortalRequests(getDb(), ctx.event.id, vendorId);
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">{t("vendorPortal.requests.empty")}</p>
      </Card>
    );
  }
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/vendor/${vendorId}/requests/${r.id}`} className="block min-h-11 rounded-xl border border-border bg-surface p-4 hover:bg-surface-muted">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{formatDay(locale, r.createdAt.toISOString().slice(0, 10))}</span>
              <Badge tone={r.closed ? "neutral" : "primary"}>{r.closed ? t("vendorPortal.requests.closed") : t("vendorPortal.requests.open")}</Badge>
              <Badge tone={r.latestQuote ? "success" : "warning"}>
                {r.latestQuote ? t("vendorPortal.requests.quoted", { version: r.latestQuote.version }) : t("vendorPortal.requests.noQuote")}
              </Badge>
            </p>
            <ul className="mt-1 text-sm text-muted">
              {r.services.map((s, i) => (
                <li key={i}>
                  {s.functionName}
                  {s.functionDate && ` · ${formatDay(locale, s.functionDate)}`} · {serviceLabel(t, { typeKey: s.typeKey, typeName: s.typeName, name: s.serviceName })}
                </li>
              ))}
            </ul>
            {r.dueDate && !r.closed && <p className="mt-1 text-sm">{t("vendorPortal.requests.dueBy", { date: formatDay(locale, r.dueDate) })}</p>}
          </Link>
        </li>
      ))}
    </ul>
  );
}
