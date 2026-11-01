import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { DocumentsPanel } from "@/components/documents-panel";
import { MoneyInput, PayerFields } from "@/components/money-fields";
import { PaymentFields } from "@/components/payment-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, LinkButton, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { BookingError, getBooking, matchLines } from "@/lib/bookings";
import { listDocuments } from "@/lib/documents";
import { listMembers } from "@/lib/events";
import { isUuid } from "@/lib/ids";
import { bookingFinance, listInvoices } from "@/lib/payments";
import { getQuote } from "@/lib/quotes";
import { getEventContext } from "@/lib/server/event-context";
import { documentLabels, eventToday, payerLabels, payerText, paymentLabels, payTone, serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { deletePaymentAction, recordPaymentAction } from "../../../budget/actions";
import { addKeyDateAction, cancelBookingAction, contractAction, removeKeyDateAction, reviseBookingAction, scheduleAction } from "../../actions";

const WARNINGS = ["condition_dropped", "over_covered", "expired"] as const;
function parseWarnings(raw: unknown): (typeof WARNINGS)[number][] {
  return typeof raw === "string" ? WARNINGS.filter((w) => raw.split(",").includes(w)) : [];
}

export default async function BookingPage({ params, searchParams }: PageProps<"/events/[eventId]/vendors/bookings/[bookingId]">) {
  const { eventId, bookingId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!isUuid(bookingId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const b = await getBooking(db, eventId, bookingId).catch((e) => {
    if (e instanceof BookingError) notFound();
    throw e;
  });
  const today = eventToday(ctx.event.timezone);
  const [fin, invoices, docs, members, quote] = await Promise.all([
    bookingFinance(db, eventId, bookingId, today),
    listInvoices(db, eventId, today, { bookingId }),
    listDocuments(db, eventId, { bookingId }),
    listMembers(db, eventId),
    b.quote ? getQuote(db, eventId, b.quote.id) : Promise.resolve(null),
  ]);
  const inr = (p: number) => formatInr(locale, p);
  const status = b.booking.status;
  const live = status !== "cancelled";
  const canBook = ctx.can("bookings.create") && live;
  const latestId = quote?.versions[quote.versions.length - 1]?.id;
  const latest = latestId && latestId !== b.quote?.id ? await getQuote(db, eventId, latestId) : null;
  const reviseLines =
    latest && quote
      ? matchLines(
          quote.lines,
          latest.lines,
          b.fulfilments.map((f) => f.f.quoteLineId).filter((x): x is string => !!x),
          new Set(latest.requirements.filter((r) => r.approvalState === "approved" && r.lifecycle !== "cancelled").map((r) => r.id)),
        )
      : [];
  const warnings = parseWarnings(sp.w);
  const rows = [...fin.milestones.map((m) => m.milestone), ...Array.from({ length: 2 }, () => null)];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("bookings.title", { vendor: b.vendor.name })}
        subtitle={`${t("quotes.total")}: ${inr(b.total)}`}
        action={<Badge tone={status === "confirmed" ? "success" : status === "cancelled" ? "neutral" : "warning"}>{t(`bookings.status.${status}`)}</Badge>}
      />
      {sp.r === "pending" && <Alert tone="warning">{t("services.submitted")}</Alert>}
      {sp.r === "auto" && <Alert tone="success">{t("services.autoApproved")}</Alert>}
      {warnings.map((w) => (
        <Alert key={w} tone="warning">
          {t(`bookings.warnings.${w}`)}
        </Alert>
      ))}
      {status === "pending_approval" && <Alert tone="warning">{t("bookings.pendingHelp")}</Alert>}

      <Card>
        <CardTitle
          action={
            b.quote ? (
              <Link href={`/events/${eventId}/vendors/quotes/${b.quote.id}`} className="text-sm text-primary underline">
                {t("quotes.version", { version: b.quote.version })}
              </Link>
            ) : undefined
          }
        >
          {t("bookings.fulfilments")}
        </CardTitle>
        <ul className="divide-y divide-border text-sm">
          {b.fulfilments.map(({ f, ...x }) => (
            <li key={f.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span>
                <span className="text-muted">
                  {x.functionName} · {serviceLabel(t, { typeKey: x.typeKey, typeName: x.typeName, name: x.serviceName })}:{" "}
                </span>
                {x.requirementTitle ?? x.lineDescription ?? t("bookings.serviceLevel")}
                {f.quantity != null && ` × ${f.quantity}${x.unit ? ` ${x.unit}` : ""}`}
              </span>
              <span>{inr(f.amountPaise + f.gstPaise)}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardTitle>{t("bookings.schedule")}</CardTitle>
        <dl className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg bg-surface-muted p-2">
            <dd className="font-semibold">{inr(fin.total)}</dd>
            <dt className="text-muted">{t("quotes.total")}</dt>
          </div>
          <div className="rounded-lg bg-success-soft p-2">
            <dd className="font-semibold text-success">{inr(fin.paid)}</dd>
            <dt>{t("bookings.paid")}</dt>
          </div>
          <div className="rounded-lg bg-surface-muted p-2">
            <dd className="font-semibold">{inr(fin.balance)}</dd>
            <dt className="text-muted">{t("bookings.balance")}</dt>
          </div>
        </dl>
        {fin.awaiting > 0 && <p className="mb-2 text-sm text-warning">{t("bookings.awaiting", { amount: inr(fin.awaiting) })}</p>}
        {fin.overpaid && <Alert tone="warning">{t("bookings.overpaid")}</Alert>}
        <ul className="divide-y divide-border text-sm">
          {fin.milestones.map((m) => (
            <li key={m.milestone.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-medium">{m.milestone.label || t(`bookings.milestoneKinds.${m.milestone.kind}`)}</span>
              {m.milestone.dueDate && <span className="text-muted">{formatDay(locale, m.milestone.dueDate)}</span>}
              {m.milestone.payer && <span className="text-muted">{payerText(t, locale, m.milestone.payer)}</span>}
              <span className="ml-auto">{inr(m.milestone.amountPaise)}</span>
              {m.status && <Badge tone={payTone[m.status]}>{t(`payments.status.${m.status}` as MessageKey)}</Badge>}
            </li>
          ))}
        </ul>
        {canBook && (
          <details className="mt-3">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("bookings.editSchedule")}</summary>
            <SimpleForm action={scheduleAction.bind(null, eventId, bookingId)} className="mt-2 space-y-3">
              <p className="text-sm text-muted">{t("bookings.scheduleHelp", { total: inr(b.total) })}</p>
              {rows.map((m, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 border-b border-border pb-3 sm:grid-cols-4">
                  <Field label={t("bookings.milestoneLabel")} htmlFor={`label_${i}`}>
                    <Input id={`label_${i}`} name={`label_${i}`} maxLength={120} defaultValue={m?.label ?? ""} />
                  </Field>
                  <Field label={t("catalogue.kind")} htmlFor={`kind_${i}`}>
                    <Select id={`kind_${i}`} name={`kind_${i}`} defaultValue={m?.kind ?? "milestone"}>
                      <option value="advance">{t("bookings.milestoneKinds.advance")}</option>
                      <option value="milestone">{t("bookings.milestoneKinds.milestone")}</option>
                      <option value="final">{t("bookings.milestoneKinds.final")}</option>
                    </Select>
                  </Field>
                  <Field label={t("bookings.due")} htmlFor={`due_${i}`}>
                    <Input id={`due_${i}`} name={`due_${i}`} type="date" defaultValue={m?.dueDate ?? ""} />
                  </Field>
                  <Field label={t("bookings.amount")} htmlFor={`amount_${i}`}>
                    <MoneyInput id={`amount_${i}`} name={`amount_${i}`} value={m?.amountPaise} />
                  </Field>
                  <div className="col-span-2 sm:col-span-4">
                    <PayerFields labels={payerLabels(t)} value={m?.payer} prefix={`payer_${i}`} id={`ms-payer-${i}`} />
                  </div>
                </div>
              ))}
              <SubmitButton>{t("common.save")}</SubmitButton>
            </SimpleForm>
          </details>
        )}
      </Card>

      <Card>
        <CardTitle>{t("payments.title")}</CardTitle>
        {fin.payments.length === 0 ? (
          <p className="text-sm text-muted">{t("payments.empty")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {fin.payments.map(({ payment: p, recordedByName }) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">{inr(p.amountPaise)}</span>
                <span className="text-muted">
                  {formatDay(locale, p.paidOn)} · {t(`payments.modes.${p.mode}`)}
                  {p.reference && ` · ${p.reference}`}
                  {recordedByName && ` · ${recordedByName}`}
                </span>
                <Badge tone={p.state === "confirmed" ? "success" : p.state === "rejected" ? "danger" : "warning"}>{t(`payments.states.${p.state}`)}</Badge>
                {ctx.decide("payments.record") === "allow" && (
                  <form action={deletePaymentAction.bind(null, eventId, p.id, `/events/${eventId}/vendors/bookings/${bookingId}`)} className="ml-auto">
                    <ConfirmButton variant="ghost" confirm={t("payments.deleteConfirm")}>
                      {t("common.delete")}
                    </ConfirmButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {status === "confirmed" && ctx.can("payments.record") && (
          <details className="mt-3">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("payments.record")}</summary>
            <SimpleForm action={recordPaymentAction.bind(null, eventId, { bookingId })} className="mt-2 space-y-3">
              <PaymentFields labels={paymentLabels(t)} today={today} id="pay" overpay invoices={invoices.map((i) => ({ id: i.invoice.id, label: `${i.invoice.number} · ${inr(i.invoice.totalPaise)}` }))} />
              <SubmitButton>{t("payments.record")}</SubmitButton>
            </SimpleForm>
          </details>
        )}
      </Card>

      <Card>
        <CardTitle
          action={
            ctx.can("invoices.edit") && live ? (
              <LinkButton href={`/events/${eventId}/budget/invoices/new?booking=${bookingId}`} variant="secondary">
                {t("invoices.add")}
              </LinkButton>
            ) : undefined
          }
        >
          {t("invoices.title")}
        </CardTitle>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted">{t("invoices.empty")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {invoices.map((i) => (
              <li key={i.invoice.id}>
                <Link href={`/events/${eventId}/budget/invoices/${i.invoice.id}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                  {i.invoice.number} · {inr(i.invoice.totalPaise)}
                  <Badge tone={payTone[i.status]}>{t(`payments.status.${i.status}` as MessageKey)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>{t("bookings.contract")}</CardTitle>
        {ctx.can("contracts.edit") ? (
          <SimpleForm action={contractAction.bind(null, eventId, bookingId)} className="space-y-3">
            <Field label={t("bookings.cancellationPolicy")} htmlFor="cp">
              <Textarea id="cp" name="cancellationPolicy" rows={2} maxLength={4000} defaultValue={b.booking.cancellationPolicy ?? ""} />
            </Field>
            <Field label={t("bookings.deliverables")} htmlFor="dl">
              <Textarea id="dl" name="deliverables" rows={2} maxLength={4000} defaultValue={b.booking.deliverables ?? ""} />
            </Field>
            <Field label={t("bookings.notes")} htmlFor="bn">
              <Textarea id="bn" name="notes" rows={2} maxLength={2000} defaultValue={b.booking.notes ?? ""} />
            </Field>
            <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
          </SimpleForm>
        ) : (
          <p className="whitespace-pre-line text-sm">{[b.booking.cancellationPolicy, b.booking.deliverables, b.booking.notes].filter(Boolean).join("\n\n")}</p>
        )}
        <h3 className="mt-4 text-sm font-semibold">{t("bookings.keyDates")}</h3>
        <ul className="divide-y divide-border text-sm">
          {b.keyDates.map((k) => (
            <li key={k.id} className="flex items-center gap-2 py-1">
              <span>
                {formatDay(locale, k.date)} · {k.label}
              </span>
              {ctx.can("contracts.edit") && (
                <form action={removeKeyDateAction.bind(null, eventId, k.id)} className="ml-auto">
                  <SubmitButton variant="ghost">{t("common.remove")}</SubmitButton>
                </form>
              )}
            </li>
          ))}
        </ul>
        {ctx.can("contracts.edit") && (
          <SimpleForm action={addKeyDateAction.bind(null, eventId, bookingId)} className="mt-2 grid gap-2 sm:grid-cols-[1fr_10rem_12rem_auto] sm:items-end">
            <Field label={t("bookings.keyDateLabel")} htmlFor="kd-label">
              <Input id="kd-label" name="label" required maxLength={120} />
            </Field>
            <Field label={t("bookings.due")} htmlFor="kd-date">
              <Input id="kd-date" name="date" type="date" required />
            </Field>
            <Field label={t("services.owner")} htmlFor="kd-who">
              <Select id="kd-who" name="assigneeId" defaultValue={ctx.user.id}>
                <option value="">{t("services.noOwner")}</option>
                {members.map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.name ?? "—"}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton variant="secondary">{t("bookings.addKeyDate")}</SubmitButton>
            <p className="text-xs text-muted sm:col-span-4">{t("bookings.keyDateHelp")}</p>
          </SimpleForm>
        )}
      </Card>

      <DocumentsPanel eventId={eventId} owner="bookingId" ownerId={bookingId} docs={docs} canEdit={ctx.can("contracts.edit")} back={`/events/${eventId}/vendors/bookings/${bookingId}`} defaultKind="contract" labels={documentLabels(t, t("bookings.documents"), sp)} />

      {canBook && latest && status === "confirmed" && reviseLines.length > 0 && (
        <Card>
          <CardTitle>{t("bookings.revise")}</CardTitle>
          <p className="mb-2 text-sm text-muted">{t("bookings.reviseHelp")}</p>
          <SimpleForm action={reviseBookingAction.bind(null, eventId, bookingId, latest.quote.id, reviseLines)}>
            <SubmitButton variant="secondary">
              {t("quotes.version", { version: latest.quote.version })}
            </SubmitButton>
          </SimpleForm>
        </Card>
      )}

      {canBook && (
        <Card>
          <CardTitle>{t("bookings.cancel")}</CardTitle>
          <SimpleForm action={cancelBookingAction.bind(null, eventId, bookingId)} className="flex flex-wrap items-end gap-2">
            <Field label={t("bookings.cancelReason")} htmlFor="cb-reason">
              <Input id="cb-reason" name="reason" maxLength={500} />
            </Field>
            <ConfirmButton variant="danger" confirm={t("bookings.cancelConfirm")}>
              {t("bookings.cancel")}
            </ConfirmButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
