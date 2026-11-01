import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { getTranslator, requireUser } from "@/lib/server/session";
import { vendorLinksForUser } from "@/lib/vendor-access";

/** The vendor portal's start page: every vendor row this login is linked to, across events (VND-10). */
export default async function VendorHome() {
  const ctx = await requireUser({ allowUnnamed: true });
  const { t, locale } = await getTranslator();
  const links = await vendorLinksForUser(getDb(), ctx.user.id);
  if (links.length === 0) {
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader title={t("vendorPortal.noAccessTitle")} />
        <Card>
          <p className="text-sm">{t("vendorPortal.noAccess")}</p>
        </Card>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("vendorPortal.chooseTitle")} subtitle={t("vendorPortal.chooseHelp")} />
      <ul className="space-y-3">
        {links.map((l) => (
          <li key={l.vendorId}>
            <Link href={`/vendor/${l.vendorId}`} className="flex min-h-11 flex-col rounded-xl border border-border bg-surface p-4 hover:bg-surface-muted">
              <span className="font-semibold">{l.eventName}</span>
              <span className="text-sm text-muted">
                {l.vendorName}
                {l.eventStart && ` · ${formatDay(locale, l.eventStart)}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
