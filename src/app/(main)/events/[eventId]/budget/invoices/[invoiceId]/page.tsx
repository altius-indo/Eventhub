import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { DocumentsPanel } from "@/components/documents-panel";
import { Alert, Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { listDocuments } from "@/lib/documents";
import { isUuid } from "@/lib/ids";
import { gstFor } from "@/lib/money";
import { getInvoice, PaymentError } from "@/lib/payments";
import { listServices } from "@/lib/services";
import { getEventContext } from "@/lib/server/event-context";
import { documentLabels, eventToday, payTone, serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { deleteInvoiceAction } from "../../actions";

export default async function InvoicePage({ params, searchParams }: PageProps<"/events/[eventId]/budget/invoices/[invoiceId]">) {
  const { eventId, invoiceId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!isUuid(invoiceId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const inv = await getInvoice(db, eventId, invoiceId, eventToday(ctx.event.timezone)).catch((e) => {
    if (e instanceof PaymentError) notFound();
    throw e;
  });
  const [services, docs] = await Promise.all([listServices(db, eventId), listDocuments(db, eventId, { invoiceId })]);
  const inr = (p: number) => formatInr(locale, p);
  const i = inv.invoice;
  const computed = i.subtotalPaise + i.cgstPaise + i.sgstPaise + i.igstPaise;
  return (
    <div className="space-y-4">
      <PageHeader
        title={`${inv.vendorName} · ${i.number}`}
        subtitle={[formatDay(locale, i.invoiceDate), i.dueDate && `${t("invoices.dueDate")}: ${formatDay(locale, i.dueDate)}`, i.supplierGstin].filter(Boolean).join(" · ")}
        action={<Badge tone={payTone[inv.status]}>{t(`payments.status.${inv.status}` as MessageKey)}</Badge>}
      />
      {sp.saved && <Alert tone="success">{t("invoices.saved")}</Alert>}
      {inv.mismatch && <Alert tone="warning">{t("invoices.mismatch", { amount: inr(Math.abs(i.totalPaise - computed)) })}</Alert>}
      <Card>
        <CardTitle>{t("invoices.lines")}</CardTitle>
        <ul className="divide-y divide-border text-sm">
          {inv.lines.map((l) => {
            const s = services.find((x) => x.id === l.serviceId);
            return (
              <li key={l.id} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  {l.description}
                  {l.hsnSac && <span className="text-muted"> · {l.hsnSac}</span>}
                  <span className="block text-muted">{s ? serviceLabel(t, s) : t("invoices.spread")}</span>
                </span>
                <span className="text-right">
                  {inr(l.amountPaise)}
                  {l.gstRateBps > 0 && <span className="block text-xs text-muted">+ {inr(gstFor(l.amountPaise, l.gstRateBps, i.taxType).tax)} ({l.gstRateBps / 100}%)</span>}
                </span>
              </li>
            );
          })}
        </ul>
        <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-border pt-3 text-sm sm:max-w-xs">
          <dt className="text-muted">{t("quotes.subtotal")}</dt>
          <dd className="text-right">{inr(i.subtotalPaise)}</dd>
          {i.cgstPaise !== 0 && (
            <>
              <dt className="text-muted">{t("invoices.cgst")}</dt>
              <dd className="text-right">{inr(i.cgstPaise)}</dd>
              <dt className="text-muted">{t("invoices.sgst")}</dt>
              <dd className="text-right">{inr(i.sgstPaise)}</dd>
            </>
          )}
          {i.igstPaise !== 0 && (
            <>
              <dt className="text-muted">{t("invoices.igst")}</dt>
              <dd className="text-right">{inr(i.igstPaise)}</dd>
            </>
          )}
          <dt className="font-semibold">{t("quotes.total")}</dt>
          <dd className="text-right font-semibold">{inr(i.totalPaise)}</dd>
          <dt className="text-muted">{t("bookings.paid")}</dt>
          <dd className="text-right">{inr(inv.paid)}</dd>
        </dl>
        {i.bookingId && (
          <p className="mt-3 text-sm">
            <Link href={`/events/${eventId}/vendors/bookings/${i.bookingId}`} className="text-primary underline">
              {t("quotes.viewBooking")}
            </Link>
          </p>
        )}
        {i.notes && <p className="mt-2 whitespace-pre-line text-sm text-muted">{i.notes}</p>}
      </Card>
      <DocumentsPanel eventId={eventId} owner="invoiceId" ownerId={i.id} docs={docs} canEdit={ctx.can("contracts.edit")} back={`/events/${eventId}/budget/invoices/${i.id}`} defaultKind="invoice" labels={documentLabels(t, t("bookings.documents"), sp)} />
      {ctx.can("invoices.edit") && (
        <form action={deleteInvoiceAction.bind(null, eventId, i.id)}>
          <ConfirmButton variant="ghost" className="text-danger" confirm={t("invoices.deleteConfirm")}>
            {t("common.delete")}
          </ConfirmButton>
        </form>
      )}
    </div>
  );
}
