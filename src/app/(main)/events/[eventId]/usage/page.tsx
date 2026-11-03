import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, CardTitle, PageHeader, cx } from "@/components/ui";
import { getDb } from "@/db";
import { intlLocale } from "@/i18n/core";
import { CHANNELS, getUsage } from "@/lib/outbox";
import { getStorageUsage } from "@/lib/storage-quota";
import type { MessageKey } from "@/i18n/core";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

/** Bytes as KB/MB/GB with the locale's digits grouping (units stay Latin, as people write them). */
function formatBytes(locale: string, n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: v < 10 && i > 0 ? 1 : 0 }).format(v)} ${units[i]}`;
}

/** LIM-01: messages used per channel and storage used, against the event's limits. */
export default async function UsagePage({ params }: PageProps<"/events/[eventId]/usage">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("limits.view")) notFound();
  const { t, locale } = await getTranslator();
  const usage = await getUsage(getDb(), eventId);
  const storage = await getStorageUsage(getDb(), eventId);
  const bytes = (v: number) => formatBytes(intlLocale(locale), v);
  const storagePct = Math.min(100, storage.pct);
  const storageLevel = storage.pct >= 95 ? "danger" : storage.pct >= 80 ? "warning" : "primary";
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

      {/* LIM-01/03: storage */}
      <Card>
        <CardTitle>{t("storage.title")}</CardTitle>
        <p className="mb-3 text-sm text-muted">{t("storage.intro")}</p>
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={storagePct}
          aria-label={t("storage.meterLabel", { pct: storage.pct })}
          className="relative h-3 overflow-hidden rounded-full bg-surface-muted"
        >
          <div
            className={cx("absolute inset-y-0 left-0", storageLevel === "danger" ? "bg-danger" : storageLevel === "warning" ? "bg-warning" : "bg-primary")}
            style={{ width: `${storagePct}%` }}
          />
        </div>
        <ul className="mt-3 space-y-1 text-sm">
          <li className="font-medium">{t("storage.used", { used: bytes(storage.used), limit: bytes(storage.limit) })}</li>
          {storage.reserved > 0 && <li className="text-muted">{t("storage.reserved", { size: bytes(storage.reserved) })}</li>}
          <li className="text-muted">{t("storage.remaining", { size: bytes(storage.remaining) })}</li>
          <li className="text-muted">{t("storage.guestLimit", { items: n(storage.limits.guestItems), size: bytes(storage.limits.guestBytes) })}</li>
        </ul>
        {storage.pct >= 100 ? (
          <div className="mt-3">
            <Alert tone="danger">{t("storage.full")}</Alert>
          </div>
        ) : storage.pct >= 80 ? (
          <div className="mt-3">
            <Alert tone="warning">{t("storage.warning", { pct: storage.pct >= 95 ? 95 : 80 })}</Alert>
          </div>
        ) : null}
        {storage.breakdown.length > 0 && (
          <>
            <h3 className="mt-4 mb-1 text-sm font-semibold">{t("storage.breakdown")}</h3>
            <ul className="space-y-1 text-sm">
              {storage.breakdown.map((b) => (
                <li key={b.key} className="flex justify-between gap-3">
                  <span>{t(`storage.sources.${b.key}` as MessageKey)}</span>
                  <span className="text-muted">{bytes(b.bytes)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <p className="text-sm text-muted">{t("usage.requestMore")}</p>
    </div>
  );
}
