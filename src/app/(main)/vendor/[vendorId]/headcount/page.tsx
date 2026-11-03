import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardTitle } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { catererFunctions } from "@/lib/caterer-headcount";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

export default async function PortalHeadcounts({ params }: PageProps<"/vendor/[vendorId]/headcount">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.headcount")) notFound();
  const { t, locale } = await getTranslator();
  const fns = await catererFunctions(getDb(), ctx.event.id, vendorId);
  return (
    <Card>
      <CardTitle>{t("headcount.functions")}</CardTitle>
      {fns.length === 0 ? (
        <p className="text-sm text-muted">{t("headcount.noFunctions")}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {fns.map((f) => (
            <li key={f.functionId}>
              <Link href={`/vendor/${vendorId}/headcount/${f.functionId}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                <span className="font-medium">{f.functionName}</span>
                {f.functionDate && <span className="text-muted">{formatDay(locale, f.functionDate)}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
