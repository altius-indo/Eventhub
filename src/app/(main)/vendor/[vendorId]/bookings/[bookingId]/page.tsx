import { notFound } from "next/navigation";
import { Alert, Badge, Card, CardTitle, LinkButton } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, formatWallClock, type MessageKey } from "@/i18n/core";
import { isUuid } from "@/lib/ids";
import { payTone, serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { todayIn } from "@/lib/tasks";
import { getPortalBooking, PortalError } from "@/lib/vendor-portal";
import { PortalDocuments } from "../../portal-documents";

const bookingTone = { awaiting_confirmation: "warning", confirmed: "success", cancelled: "neutral" } as const;

/** One booking as the vendor sees it: what's booked, payment schedule and status, invoices, files, run sheet. */
export default async function PortalBooking({ params }: PageProps<"/vendor/[vendorId]/bookings/[bookingId]">) {
  const { vendorId, bookingId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!isUuid(bookingId)) notFound();
  const { t, locale } = await getTranslator();
  const b = await getPortalBooking(getDb(), ctx.event.id, vendorId, bookingId, todayIn(ctx.event.timezone)).catch((e) => {
    if (e instanceof PortalError) notFound();
    throw e;
  });
  const inr = (p: number) => formatInr(locale, p);
  const status = b.booking.status;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg font-semibold">{inr(b.booking.total)}</span>
        <Badge tone={bookingTone[status]}>{t(`vendorPortal.bookingStatus.${status}`)}</Badge>
      </div>
      {status === "awaiting_confirmation" && <Alert tone="warning">{t("vendorPortal.bookings.awaitingHelp")}</Alert>}
      {status === "cancelled" && <Alert tone="neutral">{t("vendorPortal.bookings.cancelledHelp")}</Alert>}

      <Card>
        <CardTitle>{t("vendorPortal.bookings.booked")}</CardTitle>
        <ul className="divide-y divide-border text-sm">
          {b.fulfilments.map((f) => (
            <li key={f.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span>
                <span className="text-muted">
                  {f.functionName}
                  {f.functionDate && ` (${formatDay(locale, f.functionDate)})`} · {serviceLabel(t, { typeKey: f.typeKey, typeName: f.typeName, name: f.serviceName })}:{" "}
                </span>
                {f.requirementTitle ?? t("vendorPortal.bookings.serviceLevel")}
                {f.requirementQty != null &&
                  ` · ${t("vendorPortal.bookings.share", { quantity: f.quantity ?? f.requirementQty, of: f.requirementQty })}${f.unit ? ` ${f.unit}` : ""}`}
              </span>
              <span>{inr(f.amount + f.gst)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardTitle>{t("vendorPortal.bookings.schedule")}</CardTitle>
        {status !== "confirmed" ? (
          <p className="text-sm text-muted">{t("vendorPortal.bookings.scheduleInactive")}</p>
        ) : (
          <>
            <dl className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-lg bg-surface-muted p-2">
                <dd className="font-semibold">{inr(b.booking.total)}</dd>
                <dt className="text-muted">{t("vendorPortal.bookings.total")}</dt>
              </div>
              <div className="rounded-lg bg-success-soft p-2">
                <dd className="font-semibold text-success">{inr(b.paid)}</dd>
                <dt>{t("vendorPortal.bookings.paid")}</dt>
              </div>
              <div className="rounded-lg bg-surface-muted p-2">
                <dd className="font-semibold">{inr(b.balance)}</dd>
                <dt className="text-muted">{t("vendorPortal.bookings.balance")}</dt>
              </div>
            </dl>
            {b.milestones.length === 0 ? (
              <p className="text-sm text-muted">{t("vendorPortal.bookings.noSchedule")}</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {b.milestones.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="font-medium">{m.label || t(`bookings.milestoneKinds.${m.kind}`)}</span>
                    {m.dueDate && <span className="text-muted">{formatDay(locale, m.dueDate)}</span>}
                    <span className="ml-auto">{inr(m.amount)}</span>
                    {m.status && <Badge tone={payTone[m.status]}>{t(`payments.status.${m.status}` as MessageKey)}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {(b.booking.cancellationPolicy || b.booking.deliverables) && (
        <Card>
          <CardTitle>{t("vendorPortal.bookings.terms")}</CardTitle>
          <dl className="space-y-2 text-sm">
            {b.booking.cancellationPolicy && (
              <div>
                <dt className="text-muted">{t("vendorPortal.bookings.cancellation")}</dt>
                <dd className="whitespace-pre-line">{b.booking.cancellationPolicy}</dd>
              </div>
            )}
            {b.booking.deliverables && (
              <div>
                <dt className="text-muted">{t("vendorPortal.bookings.deliverables")}</dt>
                <dd className="whitespace-pre-line">{b.booking.deliverables}</dd>
              </div>
            )}
          </dl>
        </Card>
      )}

      <Card>
        <CardTitle
          action={
            status !== "cancelled" && ctx.can("portal.invoice") ? (
              <LinkButton href={`/vendor/${vendorId}/invoices?booking=${bookingId}`} variant="secondary">
                {t("vendorPortal.invoices.upload")}
              </LinkButton>
            ) : undefined
          }
        >
          {t("vendorPortal.invoices.title")}
        </CardTitle>
        {b.invoices.length === 0 ? (
          <p className="text-sm text-muted">{t("vendorPortal.invoices.empty")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {b.invoices.map((i) => (
              <li key={i.id} className="flex min-h-11 flex-wrap items-center gap-2 py-1">
                {i.number} · {formatDay(locale, i.invoiceDate)}
                <span className="ml-auto">{inr(i.total)}</span>
                <Badge tone={payTone[i.status]}>{t(`payments.status.${i.status}` as MessageKey)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {b.runSheet.length > 0 && (
        <Card>
          <CardTitle>{t("vendorPortal.bookings.runSheet")}</CardTitle>
          <ul className="divide-y divide-border text-sm">
            {b.runSheet.map((i) => (
              <li key={i.id} className="py-2">
                <p className="flex flex-wrap gap-2">
                  <span className="tabular-nums">{formatWallClock(locale, i.startsAt)}</span>
                  <span className="font-medium">{i.title}</span>
                </p>
                {(i.location || i.notes) && <p className="whitespace-pre-line text-muted">{[i.location, i.notes].filter(Boolean).join(" · ")}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <PortalDocuments vendorId={vendorId} docs={b.documents} title={t("vendorPortal.bookings.documents")} t={t} />
    </div>
  );
}
