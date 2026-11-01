import { notFound } from "next/navigation";
import { SubNav } from "@/components/sub-nav";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Gifts are private (GFT-07): only Hosts and Planners with gift access get past this point. */
export default async function GiftsLayout({ children, params }: LayoutProps<"/events/[eventId]/gifts">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record")) notFound();
  const { t } = await getTranslator();
  const base = `/events/${eventId}/gifts`;
  return (
    <div>
      <SubNav
        label={t("gifts.title")}
        links={[
          { href: base, label: t("gifts.register") },
          { href: `${base}/envelope`, label: t("gifts.envelope.title") },
          { href: `${base}/cash`, label: t("gifts.cash.title") },
          ...(ctx.can("gifts.manage")
            ? [
                { href: `${base}/import`, label: t("gifts.import.title") },
                { href: `${base}/thank-yous`, label: t("thankYous.title") },
              ]
            : []),
        ]}
      />
      {children}
    </div>
  );
}
