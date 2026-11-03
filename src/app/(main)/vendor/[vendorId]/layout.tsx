import { SubNav } from "@/components/sub-nav";
import { Alert, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { catererFunctions } from "@/lib/caterer-headcount";
import { listSelections, photoBookings } from "@/lib/gallery";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

export default async function VendorLayout({ children, params }: LayoutProps<"/vendor/[vendorId]">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  const { t, locale } = await getTranslator();
  const base = `/vendor/${vendorId}`;
  const catering = ctx.can("portal.headcount") ? await catererFunctions(getDb(), ctx.event.id, vendorId) : [];
  // Gallery (GAL-02/07): photographers/videographers with a booking, or anyone sent a selection.
  const gallery =
    ctx.can("portal.gallery") || ctx.viaAdmin
      ? (await photoBookings(getDb(), ctx.event.id, { vendorId })).length > 0 || (await listSelections(getDb(), ctx.event.id, { vendorId })).length > 0
      : false;
  const links = [
    { href: base, label: t("vendorPortal.nav.overview") },
    { href: `${base}/requests`, label: t("vendorPortal.nav.requests") },
    { href: `${base}/bookings`, label: t("vendorPortal.nav.bookings") },
    ...(catering.length ? [{ href: `${base}/headcount`, label: t("vendorPortal.nav.headcount") }] : []),
    ...(ctx.can("portal.chat") ? [{ href: `${base}/messages`, label: t("vendorPortal.nav.messages") }] : []),
    { href: `${base}/invoices`, label: t("vendorPortal.nav.invoices") },
    ...(gallery ? [{ href: `${base}/gallery`, label: t("vendorPortal.nav.gallery") }] : []),
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
