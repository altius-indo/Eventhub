import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, LinkButton } from "@/components/ui";
import { getDb } from "@/db";
import { formatDate, formatDay } from "@/i18n/core";
import { getCatererView, HeadcountError } from "@/lib/caterer-headcount";
import { isUuid } from "@/lib/ids";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { acknowledgeAction } from "../../actions";
import { HeadcountSummary } from "../summary";

/** A caterer's live headcount for one booked function (RSV-06), frozen after the lock (RSV-07). */
export default async function PortalHeadcount({ params }: PageProps<"/vendor/[vendorId]/headcount/[functionId]">) {
  const { vendorId, functionId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.headcount") || !isUuid(functionId)) notFound();
  const { t, locale } = await getTranslator();
  const view = await getCatererView(getDb(), ctx.event.id, vendorId, functionId).catch((e) => {
    if (e instanceof HeadcountError) notFound();
    throw e;
  });
  const when = (d: Date) => formatDate(locale, d, { dateStyle: "medium", timeStyle: "short", timeZone: ctx.event.timezone });
  const base = `/vendor/${vendorId}/headcount/${functionId}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{view.functionName}</h2>
          {view.functionDate && <p className="text-sm text-muted">{formatDay(locale, view.functionDate, { dateStyle: "full" })}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <LinkButton href={`${base}/print`} variant="secondary">
            {t("headcount.print")}
          </LinkButton>
          <a href={`${base}/export`} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-muted">
            {t("headcount.export")}
          </a>
        </div>
      </div>

      {view.frozen ? (
        <Alert tone="primary">
          <span className="block font-medium">{view.releasedAt ? t("headcount.releasedAt", { time: when(view.releasedAt) }) : t("headcount.lockedAt", { time: when(view.lockAt!) })}</span>
          <span className="block">{t("headcount.lockedHelp")}</span>
        </Alert>
      ) : (
        view.lockAt && <Alert tone="neutral">{t("headcount.lockScheduled", { time: when(view.lockAt) })}</Alert>
      )}
      {!view.frozen && view.change !== 0 && <Alert tone="warning">{t("headcount.change", { change: view.change > 0 ? `+${view.change}` : String(view.change) })}</Alert>}

      <HeadcountSummary t={t} view={view} />
      {view.share && (
        <Card>
          <p className="text-sm font-medium">{t("headcount.share", { quantity: view.share.quantity, of: view.share.of })}</p>
        </Card>
      )}
      <p className="text-xs text-muted">{t("headcount.aggregateHelp")}</p>

      {!view.frozen && (
        <Card className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm text-muted">
            {view.change === 0 ? t("headcount.noChange") : null} {view.ackedAt ? t("headcount.ackedAt", { time: when(view.ackedAt) }) : null}
          </p>
          <SimpleForm action={acknowledgeAction.bind(null, vendorId, functionId)} className="space-y-2">
            <SubmitButton variant="secondary">{t("headcount.acknowledge")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
