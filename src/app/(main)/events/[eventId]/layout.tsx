import { EventMenu, EventSettingsLink } from "@/components/event-menu";
import { EventSwitcher, type SwitcherEvent } from "@/components/event-switcher";
import { EventTabs } from "@/components/event-tabs";
import { Alert, Badge } from "@/components/ui";
import { getDb } from "@/db";
import type { Event } from "@/db/schema";
import { countPendingApprovals } from "@/lib/approvals";
import { formatDay } from "@/i18n/core";
import { logoVersion } from "@/lib/event-logo";
import { listEventsForUser } from "@/lib/events";
import { getRetention } from "@/lib/retention";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

const logoUrl = (e: Pick<Event, "id" | "logoKey">) => {
  const v = logoVersion(e.id, e.logoKey);
  return v ? `/events/${e.id}/logo?v=${v}` : null;
};

export default async function EventLayout({ children, params }: LayoutProps<"/events/[eventId]">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  // EVT-07: once the last function is over, show when the data goes.
  const retention = await getRetention(db, ctx.event);
  const pending = (await countPendingApprovals(db, [eventId])).get(eventId) ?? 0;
  const { active } = await listEventsForUser(db, ctx.user.id);
  const base = `/events/${eventId}`;
  const approvalsBadge = ctx.can("approvals.decide") ? pending : 0;
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
    ...(ctx.can("gifts.view") ? [{ href: `${base}/gifts`, label: t("nav.gifts") }] : []),
    { href: `${base}/website`, label: t("nav.website") },
    ...(ctx.can("gallery.view") ? [{ href: `${base}/gallery`, label: t("nav.gallery") }] : []),
    { href: `${base}/tasks`, label: t("nav.tasks") },
    { href: `${base}/members`, label: t("nav.members") },
    { href: `${base}/approvals`, label: t("nav.approvals"), badge: approvalsBadge },
    ...(ctx.can("audit.view") ? [{ href: `${base}/audit`, label: t("nav.audit") }] : []),
  ];

  const roleOf = (role: "host" | "planner" | null) => (role ? t(`roles.${role}`) : null);
  const current: SwitcherEvent = {
    id: ctx.event.id,
    name: ctx.event.name,
    logoUrl: logoUrl(ctx.event),
    roleLabel: ctx.viaAdmin ? t("admin.adminBadge") : roleOf(ctx.membership?.role ?? null),
    host: ctx.membership?.role === "host",
  };
  const others: SwitcherEvent[] = active
    .filter((r) => r.event.id !== eventId)
    .map((r) => ({ id: r.event.id, name: r.event.name, logoUrl: logoUrl(r.event), roleLabel: roleOf(r.role), host: r.role === "host" }));

  return (
    <div>
      {ctx.viaAdmin && (
        <div className="mb-4">
          <Alert tone="warning">{t("dashboard.adminBanner")}</Alert>
        </div>
      )}
      {retention.started && retention.deletionDate && (
        <div className="mb-4">
          <Alert tone="warning">
            {t("retention.banner", { date: formatDay(locale, retention.deletionDate, { dateStyle: "long" }) })}{" "}
            <a href={`${base}/settings#data`} className="font-medium underline">
              {t("retention.bannerLink")}
            </a>
          </Alert>
        </div>
      )}
      {/* Event toolbar: sections menu (phones), logo + name with the event switcher, role, settings. */}
      <div className="mb-3 flex items-center gap-2 sm:mb-2">
        <EventMenu
          tabs={tabs}
          label={t("eventNav.sections")}
          buttonLabel={approvalsBadge > 0 ? t("eventNav.menuWithPending", { count: approvalsBadge }) : t("eventNav.menu")}
        />
        <h1 className="sr-only">{ctx.event.name}</h1>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-lg font-semibold sm:text-2xl">
          <EventSwitcher
            current={current}
            others={others}
            labels={{
              switch: t("eventNav.switch"),
              yourEvents: t("eventNav.yourEvents"),
              allEvents: t("eventNav.allEvents"),
              createEvent: t("eventNav.createEvent"),
              current: t("eventNav.current"),
            }}
          />
          <span className="hidden shrink-0 items-center gap-2 text-base font-normal min-[400px]:flex">
            {ctx.membership && <Badge tone={ctx.membership.role === "host" ? "primary" : "neutral"}>{t(`roles.${ctx.membership.role}`)}</Badge>}
            {ctx.viaAdmin && <Badge tone="warning">{t("admin.adminBadge")}</Badge>}
          </span>
        </div>
        <EventSettingsLink href={`${base}/settings`} label={t("eventNav.settings")} />
      </div>
      <EventTabs tabs={tabs} label={t("eventNav.sections")} />
      <div aria-hidden="true" className="-mx-4 mb-5 border-b border-border sm:hidden" />
      {children}
    </div>
  );
}
