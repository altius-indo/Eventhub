import { SubNav } from "@/components/sub-nav";
import { Alert, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { catererFunctions } from "@/lib/caterer-headcount";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

export default async function VendorLayout({ children, params }: LayoutProps<"/vendor/[vendorId]">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  const { t, locale } = await getTranslator();
  const base = `/vendor/${vendorId}`;
  const catering = ctx.can("portal.headcount") ? await catererFunctions(getDb(), ctx.event.id, vendorId) : [];
  const links = [
    { href: base, label: t("vendorPortal.nav.overview") },
    { href: `${base}/requests`, label: t("vendorPortal.nav.requests") },
    { href: `${base}/bookings`, label: t("vendorPortal.nav.bookings") },
    ...(catering.length ? [{ href: `${base}/headcount`, label: t("vendorPortal.nav.headcount") }] : []),
    ...(ctx.can("portal.chat") ? [{ href: `${base}/messages`, label: t("vendorPortal.nav.messages") }] : []),
    { href: `${base}/invoices`, label: t("vendorPortal.nav.invoices") },
  ];
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={ctx.event.name} subtitle={[ctx.vendor.name, ctx.event.startDate && formatDay(locale, ctx.event.startDate)].filter(Boolean).join(" · ")} />
      {ctx.viaAdmin && (
        <div className="mb-4">
          <Alert tone="warning">{t("vendorPortal.viaAdmin")}</Alert>
        </div>
      )}
      <SubNav label={t("vendorPortal.nav.label")} links={links} />
      {children}
    </div>
  );
}
