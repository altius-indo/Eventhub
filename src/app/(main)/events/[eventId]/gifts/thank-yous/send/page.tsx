import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { estimateSend, listTracker } from "@/lib/thank-yous";
import { sendBulkAction } from "../actions";

/**
 * Bulk send with per-family review (GFT-09): every drafted note is shown in full with a tick box,
 * and the pre-send estimate (LIM-02) shows messages per channel against what's left.
 */
export default async function SendThankYousPage({ params }: PageProps<"/events/[eventId]/gifts/thank-yous/send">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage")) notFound();
  const { t } = await getTranslator();
  const db = getDb();
  const c = dctx(ctx);
  const drafts = (await listTracker(db, c, { status: "drafted" })).filter((r) => r.thankYouId && r.draftText);
  const est = await estimateSend(
    db,
    c,
    drafts.map((d) => d.thankYouId!),
  );
  const channels = (["whatsapp", "email", "sms"] as const).filter((ch) => est.byChannel[ch] > 0);
  const base = `/events/${eventId}/gifts/thank-yous`;

  return (
    <div className="space-y-4">
      <PageHeader title={t("thankYous.reviewTitle")} subtitle={t("thankYous.reviewHelp")} />
      <Link href={base} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
        ← {t("thankYous.title")}
      </Link>
      <Card>
        <CardTitle>{t("thankYous.estimate")}</CardTitle>
        <ul className="space-y-1 text-sm">
          {channels.map((ch) => (
            <li key={ch}>
              {t("thankYous.estimateLine", { channel: t(`thankYous.channels.${ch}`), count: est.byChannel[ch], remaining: est.usage[ch].remaining })}
            </li>
          ))}
          {est.skipped.no_address + est.skipped.opted_out + est.skipped.unavailable > 0 && (
            <li className="text-muted">{t("thankYous.estimateSkipped", { count: est.skipped.no_address + est.skipped.opted_out + est.skipped.unavailable })}</li>
          )}
        </ul>
        {est.overLimit.length > 0 && (
          <div className="mt-3">
            <Alert tone="danger">{t("thankYous.overLimit")}</Alert>
          </div>
        )}
      </Card>
      {drafts.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t("thankYous.noDrafts")}</p>
        </Card>
      ) : (
        <SimpleForm action={sendBulkAction.bind(null, eventId)}>
          <ul className="space-y-3">
            {drafts.map((d) => (
              <li key={d.householdId}>
                <Card>
                  <label className="flex min-h-11 items-start gap-3">
                    <input type="checkbox" name="ty" value={d.thankYouId!} defaultChecked className="mt-1 h-6 w-6 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{d.householdName}</span>
                      <span className="mt-1 block whitespace-pre-wrap text-sm">{d.draftText}</span>
                    </span>
                  </label>
                  <Link href={`${base}/${d.householdId}`} className="mt-1 inline-flex min-h-11 items-center text-sm text-primary hover:underline">
                    {t("thankYous.edit")}
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
          <SubmitButton disabled={est.overLimit.length > 0}>{t("thankYous.sendSelected")}</SubmitButton>
        </SimpleForm>
      )}
    </div>
  );
}
