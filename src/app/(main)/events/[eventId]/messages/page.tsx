import Link from "next/link";
import { Badge, Card, CardTitle, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime, formatDay } from "@/i18n/core";
import { listThreadsForMember, type ThreadListItem } from "@/lib/chat";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function MessagesPage({ params }: PageProps<"/events/[eventId]/messages">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const list = await listThreadsForMember(getDb(), eventId, ctx.user.id);
  const base = `/events/${eventId}/messages`;
  const team = list.find((x) => x.kind === "team")!;
  const fns = list.filter((x) => x.kind === "function");
  const vendors = list.filter((x) => x.kind === "vendor");

  const row = (item: ThreadListItem, label: string, sub?: string | null) => (
    <li key={item.key}>
      <Link href={`${base}/${item.key}`} className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-muted">
        <span className="min-w-0">
          <span className="block truncate font-medium">{label}</span>
          {(sub || item.lastMessageAt) && (
            <span className="block truncate text-xs text-muted">
              {[sub, item.lastMessageAt ? t("chat.lastMessage", { when: formatDateTime(locale, item.lastMessageAt) }) : null].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        {item.unread > 0 && <Badge tone="primary">{t("chat.unread", { count: item.unread })}</Badge>}
      </Link>
    </li>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("chat.title")}
        subtitle={t("chat.intro")}
        action={
          <div className="flex flex-wrap gap-2">
            {ctx.can("messaging.send") && (
              <LinkButton href={`${base}/broadcasts`} variant="secondary">
                {t("broadcasts.title")}
              </LinkButton>
            )}
            {ctx.can("limits.view") && (
              <LinkButton href={`/events/${eventId}/usage`} variant="secondary">
                {t("usage.title")}
              </LinkButton>
            )}
          </div>
        }
      />
      <Card>
        <ul>{row(team, t("chat.team"), t("chat.teamHelp"))}</ul>
      </Card>
      <Card>
        <CardTitle>{t("chat.functionsTitle")}</CardTitle>
        {fns.length ? <ul>{fns.map((f) => row(f, f.name ?? "", f.date ? formatDay(locale, f.date) : null))}</ul> : <p className="text-sm text-muted">{t("chat.noFunctions")}</p>}
      </Card>
      <Card>
        <CardTitle>{t("chat.vendorsTitle")}</CardTitle>
        {vendors.length ? <ul>{vendors.map((v) => row(v, v.name ?? ""))}</ul> : <p className="text-sm text-muted">{t("chat.noVendors")}</p>}
      </Card>
    </div>
  );
}
