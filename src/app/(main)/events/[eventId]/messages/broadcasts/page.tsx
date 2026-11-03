import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { listBroadcasts } from "@/lib/broadcasts";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function BroadcastsPage({ params }: PageProps<"/events/[eventId]/messages/broadcasts">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("messaging.send")) notFound();
  const { t, locale } = await getTranslator();
  const list = await listBroadcasts(getDb(), eventId);
  const base = `/events/${eventId}/messages/broadcasts`;
  return (
    <div className="space-y-4">
      <Link href={`/events/${eventId}/messages`} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        {t("chat.back")}
      </Link>
      <PageHeader title={t("broadcasts.title")} subtitle={t("broadcasts.intro")} action={<LinkButton href={`${base}/new`}>{t("broadcasts.new")}</LinkButton>} />
      <Card>
        {list.length === 0 ? (
          <p className="text-sm text-muted">{t("broadcasts.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {list.map((b) => (
              <li key={b.id}>
                <Link href={`${base}/${b.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 hover:bg-surface-muted">
                  <span className="min-w-0">
                    <span className="block break-words font-medium">{b.title}</span>
                    <span className="block text-xs text-muted">
                      {b.queuedAt ? t("broadcasts.queuedAt", { when: formatDateTime(locale, b.queuedAt) }) : t("broadcasts.createdAt", { when: formatDateTime(locale, b.createdAt) })}
                      {b.status !== "draft" && ` · ${t("broadcasts.recipients", { count: b.recipientCount })}`}
                    </span>
                  </span>
                  <Badge tone={b.status === "draft" ? "neutral" : b.status === "done" ? "success" : "primary"}>{t(`broadcasts.status.${b.status}`)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
