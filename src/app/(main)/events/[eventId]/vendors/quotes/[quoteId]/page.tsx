import Link from "next/link";
import { notFound } from "next/navigation";
import { DocumentsPanel } from "@/components/documents-panel";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, LinkButton, PageHeader, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr } from "@/i18n/core";
import { bookingForQuoteRoot } from "@/lib/bookings";
import { listDocuments } from "@/lib/documents";
import { isUuid } from "@/lib/ids";
import { getQuote, lineGst, QuoteError } from "@/lib/quotes";
import { getEventContext } from "@/lib/server/event-context";
import { documentLabels, eventToday, serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { bookAction, declineQuoteAction } from "../../actions";

export default async function QuotePage({ params, searchParams }: PageProps<"/events/[eventId]/vendors/quotes/[quoteId]">) {
  const { eventId, quoteId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!isUuid(quoteId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const q = await getQuote(db, eventId, quoteId).catch((e) => {
    if (e instanceof QuoteError) notFound();
    throw e;
  });
  const [booking, docs] = await Promise.all([bookingForQuoteRoot(db, eventId, q.quote.rootId), listDocuments(db, eventId, { quoteId })]);
  const today = eventToday(ctx.event.timezone);
  const inr = (p: number) => formatInr(locale, p);
  const canBook = ctx.can("bookings.create") && !booking && !q.quote.declinedAt && q.latest;
  const reqTitle = (id: string | null) => q.requirements.find((r) => r.id === id)?.title ?? "";
  const base = `/events/${eventId}/vendors`;

  const lineRow = (l: (typeof q.lines)[number]) => (
    <li key={l.id} className="flex flex-wrap items-center gap-2 py-2">
      {canBook && (
        <label className="flex min-h-11 min-w-11 items-center justify-center">
          <span className="sr-only">{l.description ?? reqTitle(l.requirementId)}</span>
          <input type="checkbox" name="line" value={l.id} defaultChecked form="book-form" className="h-5 w-5" />
        </label>
      )}
      <span className="min-w-0 flex-1">
        {l.scope === "requirement" ? reqTitle(l.requirementId) : (l.description ?? "—")}
        {l.quantity != null && <span className="text-sm text-muted"> × {l.quantity}</span>}
        {l.conditional && (
          <span className="ml-2">
            <Badge tone="warning">{t("quotes.conditional")}</Badge>
          </span>
        )}
      </span>
      <span className="text-right">
        {inr(l.amountPaise)}
        {lineGst(l, q.quote.taxType) !== 0 && <span className="block text-xs text-muted">{lineGst(l, q.quote.taxType) < 0 ? "−" : "+"} {inr(Math.abs(lineGst(l, q.quote.taxType)))} GST</span>}
      </span>
    </li>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("quotes.quoteTitle", { vendor: q.vendorName })}
        subtitle={[t("quotes.version", { version: q.quote.version }), q.quote.vendorRef && `#${q.quote.vendorRef}`, q.quote.validUntil && `${t("quotes.validUntil")}: ${formatDay(locale, q.quote.validUntil)}`]
          .filter(Boolean)
          .join(" · ")}
        action={
          <div className="flex flex-wrap gap-2">
            {!q.latest && <Badge tone="warning">{t("quotes.versions")}</Badge>}
            {q.quote.declinedAt && <Badge>{t("services.declined")}</Badge>}
            {q.quote.validUntil && q.quote.validUntil < today && <Badge tone="warning">{t("services.expiredQuote")}</Badge>}
          </div>
        }
      />
      {sp.saved && <Alert tone="success">{t("quotes.saved")}</Alert>}
      {booking && (
        <Alert tone={booking.status === "confirmed" ? "success" : "warning"}>
          {booking.status === "confirmed" ? t("quotes.booked") : t("quotes.bookingPending")} ·{" "}
          <Link href={`${base}/bookings/${booking.id}`} className="underline">
            {t("quotes.viewBooking")}
          </Link>
        </Alert>
      )}

      <Card>
        <CardTitle>{t("quotes.lines")}</CardTitle>
        {q.services.map((s) => (
          <section key={s.id} className="mb-3">
            <h3 className="text-sm font-semibold">
              {s.functionName} · {serviceLabel(t, s)}
            </h3>
            <ul className="divide-y divide-border">{q.lines.filter((l) => l.serviceId === s.id).map(lineRow)}</ul>
          </section>
        ))}
        {q.lines.some((l) => l.scope === "package") && (
          <section className="mb-3">
            <h3 className="text-sm font-semibold">{t("quotes.package")}</h3>
            <ul className="divide-y divide-border">{q.lines.filter((l) => l.scope === "package").map(lineRow)}</ul>
          </section>
        )}
        <dl className="grid grid-cols-2 gap-1 border-t border-border pt-3 text-sm sm:max-w-xs sm:justify-self-end">
          <dt className="text-muted">{t("quotes.subtotal")}</dt>
          <dd className="text-right">{inr(q.subtotal)}</dd>
          <dt className="text-muted">
            {t("quotes.gst")} ({t(`quotes.taxTypes.${q.quote.taxType}`)})
          </dt>
          <dd className="text-right">{inr(q.gst)}</dd>
          <dt className="font-semibold">{t("quotes.total")}</dt>
          <dd className="text-right font-semibold">{inr(q.total)}</dd>
        </dl>
        {(q.quote.allOrNothing || q.quote.minFunctions) && (
          <p className="mt-2 text-sm">
            {t("quotes.packageConditions")}: {q.quote.allOrNothing ? t("quotes.conditionAll") : t("quotes.conditionMin", { count: q.quote.minFunctions ?? 0 })}
          </p>
        )}
        {q.quote.terms && <p className="mt-2 whitespace-pre-line text-sm text-muted">{q.quote.terms}</p>}
      </Card>

      {q.services.length > 1 && (
        <Card>
          <CardTitle action={<LinkButton href={`${base}/quotes/${q.quote.id}/compare`} variant="secondary">{t("quotes.comparePackage")}</LinkButton>}>{t("quotes.perService")}</CardTitle>
          <ul className="divide-y divide-border text-sm">
            {q.services.map((s) => (
              <li key={s.id} className="flex flex-wrap justify-between gap-2 py-2">
                <Link href={`/events/${eventId}/services/${s.id}`} className="text-primary underline">
                  {s.functionName} · {serviceLabel(t, s)}
                </Link>
                <span>
                  {inr(s.amount + s.gst)} <span className="text-muted">({t("quotes.allocated")})</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {canBook && (
        <Card>
          <CardTitle>{t("quotes.book")}</CardTitle>
          <p className="mb-3 text-sm text-muted">{t("quotes.bookHelp")}</p>
          <SimpleForm id="book-form" action={bookAction.bind(null, eventId, q.quote.id)} className="space-y-3">
            <Field label={t("bookings.notes")} htmlFor="book-notes">
              <Textarea id="book-notes" name="notes" rows={2} maxLength={2000} />
            </Field>
            <SubmitButton>{t("quotes.bookButton")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {q.versions.length > 1 &&
          q.versions.map((v) => (
            <LinkButton key={v.id} href={`${base}/quotes/${v.id}`} variant={v.id === q.quote.id ? "primary" : "secondary"}>
              {t("quotes.version", { version: v.version })}
            </LinkButton>
          ))}
        {ctx.can("vendors.edit") && q.quote.requestId && q.latest && (
          <LinkButton href={`${base}/requests/${q.quote.requestId}/quote?revise=${q.quote.id}`} variant="secondary">
            {t("quotes.revise")}
          </LinkButton>
        )}
        {ctx.can("vendors.edit") && !booking && (
          <form action={declineQuoteAction.bind(null, eventId, q.quote.id, !q.quote.declinedAt)}>
            <SubmitButton variant="ghost">{q.quote.declinedAt ? t("quotes.undecline") : t("quotes.decline")}</SubmitButton>
          </form>
        )}
      </div>

      <DocumentsPanel eventId={eventId} owner="quoteId" ownerId={q.quote.id} docs={docs} canEdit={ctx.can("contracts.edit")} back={`${base}/quotes/${q.quote.id}`} defaultKind="quote" labels={documentLabels(t, t("bookings.documents"), sp)} />
    </div>
  );
}
