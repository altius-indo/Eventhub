import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { listNotifications, markRead, renderNotification } from "@/lib/notifications";
import { getTranslator, requireUser, safeNext } from "@/lib/server/session";

/**
 * Notification centre (MSG-05): text rendered now, in the reader's language (ADR-0029).
 * Opening the page marks what's shown as read; new ones keep their "New" badge for this view.
 */
export default async function NotificationsPage() {
  const { user } = await requireUser({ allowUnnamed: true });
  const { t, locale } = await getTranslator();
  const db = getDb();
  const rows = await listNotifications(db, user.id, { limit: 100 });
  const unread = rows.filter((r) => !r.n.readAt).map((r) => r.n.id);
  if (unread.length) await markRead(db, user.id, unread);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={t("notifications.title")}
        action={
          <Link href="/account/notifications" className="inline-flex min-h-11 items-center text-sm text-primary underline">
            {t("notifications.prefsLink")}
          </Link>
        }
      />
      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t("notifications.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map(({ n, eventName }) => {
              const text = renderNotification(locale, n);
              const body = (
                <>
                  <span className="flex flex-wrap items-center gap-2">
                    {!n.readAt && <Badge tone="primary">{t("notifications.new")}</Badge>}
                    <span className="break-words">{text}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{[eventName, formatDateTime(locale, n.createdAt)].filter(Boolean).join(" · ")}</span>
                </>
              );
              return (
                <li key={n.id} className="py-2">
                  {n.href ? (
                    <Link href={safeNext(n.href, "/notifications")} className="block min-h-11 rounded-lg px-1 py-1 hover:bg-surface-muted">
                      {body}
                    </Link>
                  ) : (
                    <div className="px-1 py-1">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
