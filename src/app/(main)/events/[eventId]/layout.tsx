import { EventTabs } from "@/components/event-tabs";
import { Alert, Badge } from "@/components/ui";
import { getDb } from "@/db";
import { countPendingApprovals } from "@/lib/approvals";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function EventLayout({ children, params }: LayoutProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const pending = (await countPendingApprovals(getDb(), [eventId])).get(eventId) ?? 0;
  const base = `/events/${eventId}`;
  const tabs = [
    { href: base, label: t("nav.dashboard") },
    { href: `${base}/guests`, label: t("nav.guests") },
    { href: `${base}/schedule`, label: t("nav.schedule") },
    { href: `${base}/rsvp`, label: t("nav.rsvp") },
    { href: `${base}/logistics`, label: t("nav.logistics") },
    { href: `${base}/services`, label: t("nav.services") },
    { href: `${base}/vendors`, label: t("nav.vendors") },
    { href: `${base}/budget`, label: t("nav.budget") },
    { href: `${base}/messages`, label: t("nav.messages") },
    ...(ctx.can("gifts.record") ? [{ href: `${base}/gifts`, label: t("nav.gifts") }] : []),
    { href: `${base}/website`, label: t("nav.website") },
    { href: `${base}/tasks`, label: t("nav.tasks") },
    { href: `${base}/members`, label: t("nav.members") },
    { href: `${base}/approvals`, label: t("nav.approvals"), badge: ctx.can("approvals.decide") ? pending : 0 },
    ...(ctx.can("audit.view") ? [{ href: `${base}/audit`, label: t("nav.audit") }] : []),
    { href: `${base}/settings`, label: t("nav.settings") },
  ];

  return (
    <div>
      {ctx.viaAdmin && (
        <div className="mb-4">
          <Alert tone="warning">{t("dashboard.adminBanner")}</Alert>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold sm:text-2xl">{ctx.event.name}</h1>
        {ctx.membership && <Badge tone={ctx.membership.role === "host" ? "primary" : "neutral"}>{t(`roles.${ctx.membership.role}`)}</Badge>}
        {ctx.viaAdmin && <Badge tone="warning">{t("admin.adminBadge")}</Badge>}
      </div>
      <EventTabs tabs={tabs} />
      {children}
    </div>
  );
}
