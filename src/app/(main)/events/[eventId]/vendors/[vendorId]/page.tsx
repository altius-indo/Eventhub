import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { DocumentsPanel } from "@/components/documents-panel";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Input, LinkButton, PageHeader, Select } from "@/components/ui";
import { VendorFields } from "@/components/vendor-fields";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { listBookings } from "@/lib/bookings";
import { listServiceTypes } from "@/lib/catalogue";
import { listDocuments } from "@/lib/documents";
import { isUuid } from "@/lib/ids";
import { listInvoices } from "@/lib/payments";
import { listQuoteRequests, listQuotes } from "@/lib/quotes";
import { getVendor, VendorError } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { documentLabels, eventToday, payTone, typeLabel, vendorLabels } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { archiveVendorAction, deleteVendorAction, rateVendorAction, setSecretsAction, updateVendorAction } from "../actions";

export default async function VendorPage({ params, searchParams }: PageProps<"/events/[eventId]/vendors/[vendorId]">) {
  const { eventId, vendorId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!isUuid(vendorId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const v = await getVendor(db, eventId, vendorId).catch((e) => {
    if (e instanceof VendorError) notFound();
    throw e;
  });
  const today = eventToday(ctx.event.timezone);
  const [types, requests, quotes, bookings, invoices, docs] = await Promise.all([
    listServiceTypes(db, eventId, "service"),
    listQuoteRequests(db, eventId, { vendorId }),
    listQuotes(db, eventId, { vendorId }),
    listBookings(db, eventId, { vendorId, includeCancelled: true }),
    listInvoices(db, eventId, today, { vendorId }),
    listDocuments(db, eventId, { vendorId }),
  ]);
  const canEdit = ctx.can("vendors.edit");
  const base = `/events/${eventId}/vendors`;
  return (
    <div className="space-y-4">
      <PageHeader
        title={v.name}
        subtitle={[v.contactName, v.phone, v.email].filter(Boolean).join(" · ")}
        action={v.archivedAt ? <Badge>{t("vendors.archived")}</Badge> : undefined}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle action={canEdit ? <LinkButton href={`${base}/requests/new?vendor=${v.id}`} variant="secondary">{t("quotes.newRequest")}</LinkButton> : undefined}>
            {t("vendors.quotesTitle")}
          </CardTitle>
          {requests.length === 0 && quotes.length === 0 ? (
            <p className="text-sm text-muted">{t("quotes.noRequests")}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {requests.map((r) => (
                <li key={r.request.id}>
                  <Link href={`${base}/requests/${r.request.id}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                    {t("vendors.requests")} · {formatDay(locale, r.request.createdAt.toISOString().slice(0, 10))}
                    <Badge>{r.request.closedAt ? t("quotes.closed") : t("quotes.open")}</Badge>
                  </Link>
                </li>
              ))}
              {quotes.map((q) => (
                <li key={q.quote.id}>
                  <Link href={`${base}/quotes/${q.quote.id}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                    {t("quotes.version", { version: q.quote.version })}
                    {q.quote.vendorRef && <span className="text-muted">#{q.quote.vendorRef}</span>}
                    {q.quote.declinedAt && <Badge>{t("services.declined")}</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardTitle>{t("vendors.bookingsTitle")}</CardTitle>
          {bookings.length === 0 ? (
            <p className="text-sm text-muted">{t("bookings.empty")}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {bookings.map((b) => (
                <li key={b.booking.id}>
                  <Link href={`${base}/bookings/${b.booking.id}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                    {formatInr(locale, b.booking.subtotalPaise + b.booking.gstPaise)}
                    <Badge tone={b.booking.status === "confirmed" ? "success" : b.booking.status === "cancelled" ? "neutral" : "warning"}>{t(`bookings.status.${b.booking.status}`)}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {invoices.length > 0 && (
            <>
              <h3 className="mt-3 text-sm font-semibold">{t("vendors.invoicesTitle")}</h3>
              <ul className="divide-y divide-border text-sm">
                {invoices.map((i) => (
                  <li key={i.invoice.id}>
                    <Link href={`/events/${eventId}/budget/invoices/${i.invoice.id}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                      {i.invoice.number} · {formatInr(locale, i.invoice.totalPaise)}
                      <Badge tone={payTone[i.status]}>{t(`payments.status.${i.status}` as MessageKey)}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      {canEdit && (
        <Card>
          <CardTitle>{t("common.save")}</CardTitle>
          <SimpleForm action={updateVendorAction.bind(null, eventId, v.id)}>
            <VendorFields
              labels={vendorLabels(t)}
              value={v}
              selected={v.typeIds}
              types={types.map((ty) => ({ id: ty.id, label: typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name }) }))}
            />
            <SubmitButton>{t("common.save")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}

      <Card>
        <CardTitle
          action={
            ctx.can("vendors.bank_view") && (v.bankEnc || v.panEnc) ? (
              <LinkButton href={`${base}/${v.id}/bank`} variant="secondary">
                {t("vendors.reveal")}
              </LinkButton>
            ) : undefined
          }
        >
          {t("vendors.bank")}
        </CardTitle>
        <p className="text-sm text-muted">{t("vendors.bankHelp")}</p>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted">{t("vendors.pan")}</dt>
          <dd>{v.panLast4 ? t("vendors.masked", { last4: v.panLast4 }) : t("vendors.notSet")}</dd>
          <dt className="text-muted">{t("vendors.accountNumber")}</dt>
          <dd>{v.bankLast4 ? t("vendors.masked", { last4: v.bankLast4 }) : t("vendors.notSet")}</dd>
        </dl>
        {canEdit && ctx.can("vendors.bank_view") && (
          <details className="mt-3">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("vendors.setSecrets")}</summary>
            <SimpleForm action={setSecretsAction.bind(null, eventId, v.id)} className="mt-2 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("vendors.pan")} htmlFor="s-pan">
                  <Input id="s-pan" name="pan" maxLength={10} autoComplete="off" autoCapitalize="characters" />
                </Field>
                <Field label={t("vendors.accountName")} htmlFor="s-an">
                  <Input id="s-an" name="accountName" maxLength={120} autoComplete="off" />
                </Field>
                <Field label={t("vendors.accountNumber")} htmlFor="s-acct">
                  <Input id="s-acct" name="accountNumber" inputMode="numeric" maxLength={20} autoComplete="off" />
                </Field>
                <Field label={t("vendors.ifsc")} htmlFor="s-ifsc">
                  <Input id="s-ifsc" name="ifsc" maxLength={11} autoComplete="off" autoCapitalize="characters" />
                </Field>
                <Field label={t("vendors.upi")} htmlFor="s-upi">
                  <Input id="s-upi" name="upi" maxLength={100} autoComplete="off" />
                </Field>
              </div>
              <SubmitButton>{t("common.save")}</SubmitButton>
            </SimpleForm>
          </details>
        )}
      </Card>

      {canEdit && (
        <Card>
          <CardTitle>{t("vendors.rating")}</CardTitle>
          <SimpleForm action={rateVendorAction.bind(null, eventId, v.id)} className="flex flex-wrap items-end gap-2">
            <Field label={t("vendors.rating")} htmlFor="rate">
              <Select id="rate" name="rating" defaultValue={v.rating ?? ""}>
                <option value="">{t("vendors.noRating")}</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {"★".repeat(n)} {t("vendors.stars", { count: n })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("vendors.ratingNote")} htmlFor="rate-note">
              <Input id="rate-note" name="ratingNote" maxLength={500} defaultValue={v.ratingNote ?? ""} />
            </Field>
            <SubmitButton variant="secondary">{t("vendors.rate")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}

      <DocumentsPanel eventId={eventId} owner="vendorId" ownerId={v.id} docs={docs} canEdit={ctx.can("contracts.edit")} back={`${base}/${v.id}`} labels={documentLabels(t, t("bookings.documents"), sp)} />

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <form action={archiveVendorAction.bind(null, eventId, v.id, !v.archivedAt)}>
            <SubmitButton variant="secondary">{v.archivedAt ? t("vendors.unarchive") : t("vendors.archive")}</SubmitButton>
          </form>
          <SimpleForm action={deleteVendorAction.bind(null, eventId, v.id)} className="space-y-2">
            <ConfirmButton variant="danger" confirm={t("vendors.deleteConfirm")}>
              {t("common.delete")}
            </ConfirmButton>
          </SimpleForm>
        </div>
      )}
    </div>
  );
}
