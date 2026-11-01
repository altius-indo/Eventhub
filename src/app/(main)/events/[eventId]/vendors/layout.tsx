import { SubNav } from "@/components/sub-nav";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function VendorsLayout({ children, params }: LayoutProps<"/events/[eventId]/vendors">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t } = await getTranslator();
  const base = `/events/${eventId}/vendors`;
  return (
    <div>
      <SubNav
        label={t("vendors.title")}
        links={[
          { href: base, label: t("vendors.directory") },
          { href: `${base}/requests`, label: t("vendors.requests") },
          { href: `${base}/bookings`, label: t("vendors.bookings") },
        ]}
      />
      {children}
    </div>
  );
}
