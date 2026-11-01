import { SubNav } from "@/components/sub-nav";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function ServicesLayout({ children, params }: LayoutProps<"/events/[eventId]/services">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t } = await getTranslator();
  const base = `/events/${eventId}/services`;
  return (
    <div>
      <SubNav
        label={t("services.title")}
        links={[
          { href: base, label: t("services.byFunction") },
          { href: `${base}/gaps`, label: t("services.gaps") },
          { href: `${base}/catalogue`, label: t("services.catalogue") },
        ]}
      />
      {children}
    </div>
  );
}
