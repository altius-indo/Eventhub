import { notFound } from "next/navigation";
import { SubNav } from "@/components/sub-nav";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Gifts to give and thank-you notes (GFT-07): Hosts and Planners. */
export default async function GiftsLayout({ children, params }: LayoutProps<"/events/[eventId]/gifts">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.view")) notFound();
  const { t } = await getTranslator();
  const base = `/events/${eventId}/gifts`;
  return (
    <div>
      <SubNav
        label={t("gifts.title")}
        links={[
          { href: base, label: t("gifts.list") },
          { href: `${base}/thank-yous`, label: t("thankYous.title") },
        ]}
      />
      {children}
    </div>
  );
}
