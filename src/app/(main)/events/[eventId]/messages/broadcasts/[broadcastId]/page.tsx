import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { BroadcastFields } from "@/components/broadcast-fields";
import { ConfirmButton } from "@/components/confirm-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { BroadcastError, broadcastStats, estimateBroadcast, getBroadcast, segmentOptions, STAT_KEYS } from "@/lib/broadcasts";
import { CHANNELS } from "@/lib/outbox";
import { getEventContext } from "@/lib/server/event-context";
import { appUrl, getTranslator } from "@/lib/server/session";
import { deleteDraftAction, sendAction, updateDraftAction } from "../actions";

export default async function BroadcastPage({ params, searchParams }: PageProps<"/events/[eventId]/messages/broadcasts/[broadcastId]">) {
  const { eventId, broadcastId } = await params;
  const { sent } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("messaging.send")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  let b;
  try {
    b = await getBroadcast(db, eventId, broadcastId);
  } catch (e) {
    if (e instanceof BroadcastError) notFound();
    throw e;
  }
  const back = (
    <Link href={`/events/${eventId}/messages/broadcasts`} className="inline-flex min-h-11 items-center text-sm text-primary underline">
      {t("broadcasts.title")}
    </Link>
  );
  const channelName = (c: (typeof CHANNELS)[number]) => t(`broadcasts.channelNames.${c}`);

  if (b.status === "draft") {
    const [est, options] = await Promise.all([estimateBroadcast(db, b, appUrl()), segmentOptions(db, eventId)]);
    const used = CHANNELS.filter((c) => b.channels.includes(c));
    return (
      <div className="space-y-4">
        {back}
        <PageHeader title={b.title} subtitle={<Badge>{t("broadcasts.status.draft")}</Badge>} />
        <Card>
          <CardTitle>{t("broadcasts.estimateTitle")}</CardTitle>
          <ul className="space-y-1 text-sm">
            <li>{t("broadcasts.families", { count: est.households })}</li>
            <li className="font-medium">{t("broadcasts.messagesTotal", { count: est.messages })}</li>
            {used.map((c) => (
              <li key={c}>
                {t("broadcasts.perChannel", { channel: channelName(c), count: est.byChannel[c], left: est.usage[c].remaining })}
                {!est.usage[c].connected && (
                  <>
                    {" "}
                    <Badge tone="warning">{t("usage.notConnected")}</Badge>
                  </>
                )}
              </li>
            ))}
            {est.skipped.no_address > 0 && <li className="text-muted">{t("broadcasts.skippedNoAddress", { count: est.skipped.no_address })}</li>}
            {est.skipped.opted_out > 0 && <li className="text-muted">{t("broadcasts.skippedOptedOut", { count: est.skipped.opted_out })}</li>}
            {est.skipped.unavailable > 0 && <li className="text-muted">{t("broadcasts.skippedUnavailable", { count: est.skipped.unavailable })}</li>}
          </ul>
          {est.overLimit.length > 0 && (
            <div className="mt-3">
              <Alert tone="danger">{t("broadcasts.overLimit", { channels: est.overLimit.map(channelName).join(", ") })}</Alert>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <SimpleForm action={sendAction.bind(null, eventId, b.id)} className="space-y-2">
              <ConfirmButton confirm={t("broadcasts.sendConfirm", { count: est.messages })} disabled={est.messages === 0 || est.overLimit.length > 0}>
                {t("broadcasts.sendNow")}
              </ConfirmButton>
            </SimpleForm>
            <SimpleForm action={deleteDraftAction.bind(null, eventId, b.id)} className="space-y-2">
              <ConfirmButton variant="secondary" confirm={t("broadcasts.deleteConfirm")}>
                {t("broadcasts.deleteDraft")}
              </ConfirmButton>
            </SimpleForm>
          </div>
        </Card>
        <Card>
          <CardTitle>{t("broadcasts.editTitle")}</CardTitle>
          <SimpleForm action={updateDraftAction.bind(null, eventId, b.id)}>
            <BroadcastFields t={t} options={options} draft={b} />
            <SubmitButton variant="secondary">{t("broadcasts.updateDraft")}</SubmitButton>
          </SimpleForm>
        </Card>
      </div>
    );
  }

  const stats = await broadcastStats(db, eventId, b.id);
  const active = b.status === "queued" || b.status === "sending";
  return (
    <div className="space-y-4">
      {back}
      {active && <AutoRefresh seconds={10} />}
      <PageHeader
        title={b.title}
        subtitle={
          <>
            <Badge tone={b.status === "done" ? "success" : "primary"}>{t(`broadcasts.status.${b.status}`)}</Badge>{" "}
            {b.queuedAt && t("broadcasts.queuedAt", { when: formatDateTime(locale, b.queuedAt) })} · {t("broadcasts.recipients", { count: b.recipientCount })}
          </>
        }
      />
      {sent === "1" && <Alert tone="success">{t("broadcasts.queuedInfo")}</Alert>}
      <Card>
        <CardTitle>{t("broadcasts.statsTitle")}</CardTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3 font-medium">{t("broadcasts.channelCol")}</th>
                {STAT_KEYS.map((k) => (
                  <th key={k} className="py-1 pr-3 text-right font-medium">
                    {t(`broadcasts.stat.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CHANNELS.filter((c) => b.channels.includes(c) || STAT_KEYS.some((k) => stats[c][k] > 0)).map((c) => (
                <tr key={c} className="border-t border-border">
                  <td className="py-2 pr-3">{channelName(c)}</td>
                  {STAT_KEYS.map((k) => (
                    <td key={k} className="py-2 pr-3 text-right tabular-nums">
                      {stats[c][k]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card>
        <CardTitle>{t("broadcasts.messageTitle")}</CardTitle>
        <p className="whitespace-pre-wrap break-words text-sm">{b.body.en}</p>
        {b.body.hi && (
          <p lang="hi" className="mt-3 whitespace-pre-wrap break-words border-t border-border pt-3 text-sm">
            {b.body.hi}
          </p>
        )}
      </Card>
    </div>
  );
}
