import { notFound } from "next/navigation";
import { SubNav } from "@/components/sub-nav";
import { getDb } from "@/db";
import { openRemovalCount, pendingCount } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Post-event gallery (GAL-01..08): Hosts, Planners and App Admins. */
export default async function GalleryLayout({ children, params }: LayoutProps<"/events/[eventId]/gallery">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gallery.view")) notFound();
  const { t } = await getTranslator();
  const base = `/events/${eventId}/gallery`;
  const [pending, removals] = await Promise.all([pendingCount(getDb(), eventId), openRemovalCount(getDb(), eventId)]);
  const count = (label: string, n: number) => (n > 0 ? `${label} (${n})` : label);
  return (
    <div>
      <SubNav
        label={t("gallery.nav.label")}
        links={[
          { href: base, label: t("gallery.nav.albums") },
          ...(ctx.can("gallery.moderate")
            ? [
                { href: `${base}/review`, label: count(t("gallery.nav.review"), pending) },
                { href: `${base}/removals`, label: count(t("gallery.nav.removals"), removals) },
              ]
            : []),
          { href: `${base}/favourites`, label: t("gallery.nav.favourites") },
          ...(ctx.can("gallery.moderate") ? [{ href: `${base}/settings`, label: t("gallery.nav.settings") }] : []),
        ]}
      />
      {children}
    </div>
  );
}
