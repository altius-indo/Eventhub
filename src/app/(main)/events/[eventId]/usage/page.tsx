import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, CardTitle, PageHeader, cx } from "@/components/ui";
import { getDb } from "@/db";
import { intlLocale } from "@/i18n/core";
import { CHANNELS, getUsage } from "@/lib/outbox";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** LIM-01: messages used per channel against the event's limits. */
export default async function UsagePage({ params }: PageProps<"/events/[eventId]/usage">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("limits.view")) notFound();
  const { t, locale } = await getTranslator();
  const usage = await getUsage(getDb(), eventId);
  const n = (v: number) => new Intl.NumberFormat(intlLocale(locale)).format(v);
  const anyDisconnected = CHANNELS.some((c) => !usage[c].connected);

  return (
    <div className="space-y-4">
      <Link href={`/events/${eventId}/messages`} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        {t("chat.back")}
      </Link>
      <PageHeader title={t("usage.title")} subtitle={t("usage.intro")} />
      <div className="grid gap-4 sm:grid-cols-3">
        {CHANNELS.map((c) => {
          const u = usage[c];
          const pct = u.limit > 0 ? Math.min(100, Math.round(((u.used + u.reserved) / u.limit) * 100)) : 100;
          const usedPct = u.limit > 0 ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;
          const level = usedPct >= 100 ? "danger" : usedPct >= 95 ? "danger" : usedPct >= 80 ? "warning" : "primary";
          const name = t(`broadcasts.channelNames.${c}`);
          return (
            <Card key={c}>
              <CardTitle action={u.connected ? <Badge tone="success">{t("usage.connected")}</Badge> : <Badge tone="warning">{t("usage.notConnected")}</Badge>}>{name}</CardTitle>
              <div
                role="meter"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usedPct}
                aria-label={t("usage.meterLabel", { channel: name, pct: usedPct })}
                className="relative h-3 overflow-hidden rounded-full bg-surface-muted"
              >
                <div className="absolute inset-y-0 left-0 bg-primary-soft" style={{ width: `${pct}%` }} />
                <div className={cx("absolute inset-y-0 left-0", level === "danger" ? "bg-danger" : level === "warning" ? "bg-warning" : "bg-primary")} style={{ width: `${usedPct}%` }} />
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                <li className="font-medium">{t("usage.used", { used: n(u.used), limit: n(u.limit) })}</li>
                {u.reserved > 0 && <li className="text-muted">{t("usage.reserved", { count: n(u.reserved) })}</li>}
                <li className="text-muted">{t("usage.remaining", { count: n(u.remaining) })}</li>
              </ul>
              {usedPct >= 100 ? (
                <div className="mt-3">
                  <Alert tone="danger">{t("usage.full")}</Alert>
                </div>
              ) : usedPct >= 80 ? (
                <div className="mt-3">
                  <Alert tone="warning">{t("usage.warning", { pct: usedPct >= 95 ? 95 : 80 })}</Alert>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
      {anyDisconnected && <Alert>{t("usage.notConnectedHelp")}</Alert>}
      <p className="text-sm text-muted">{t("usage.requestMore")}</p>
    </div>
  );
}
