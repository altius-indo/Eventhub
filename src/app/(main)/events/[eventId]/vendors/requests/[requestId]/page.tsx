import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, LinkButton, PageHeader, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatWallClock } from "@/i18n/core";
import { isUuid } from "@/lib/ids";
import { getQuoteRequest, QuoteError } from "@/lib/quotes";
import { getVendor } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { closeRequestAction } from "../../actions";

/**
 * The vendor brief (VND-02): each service's function, date, venue and requirements.
 * Never shows budget estimates. Printable and shareable on WhatsApp until the vendor portal (M6).
 */
export default async function RequestPage({ params, searchParams }: PageProps<"/events/[eventId]/vendors/requests/[requestId]">) {
  const { eventId, requestId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!isUuid(requestId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const r = await getQuoteRequest(db, eventId, requestId).catch((e) => {
    if (e instanceof QuoteError) notFound();
    throw e;
  });
  const vendor = await getVendor(db, eventId, r.request.vendorId);
  const canEdit = ctx.can("vendors.edit");

  const lines: string[] = [`${ctx.event.name} · ${t("quotes.brief")}`, t("quotes.briefIntro"), ""];
  for (const s of r.services) {
    lines.push(`*${s.fn.name}${s.fn.date ? ` · ${formatDay(locale, s.fn.date)}` : ""}* · ${serviceLabel(t, { ...s.service, typeKey: s.typeKey, typeName: s.typeName })}`);
    if (s.fn.venueName) lines.push(s.fn.venueName);
    if (s.service.brief) lines.push(s.service.brief);
    for (const q of s.requirements) lines.push(`• ${q.title}${q.quantity != null ? `: ${q.quantity} ${q.unit ?? ""}` : ""}${q.specs ? ` (${q.specs.replace(/\s+/g, " ")})` : ""}`);
    lines.push("");
  }
  if (r.request.dueDate) lines.push(`${t("quotes.dueDate")}: ${formatDay(locale, r.request.dueDate)}`);
  if (r.request.message) lines.push(r.request.message);
  const text = lines.join("\n");
  const phone = vendor.phone?.replace(/\D/g, "");
  const wa = `https://wa.me/${phone && phone.length >= 10 ? (phone.length === 10 ? `91${phone}` : phone) : ""}?text=${encodeURIComponent(text)}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("quotes.requestTitle", { vendor: r.vendorName })}
        action={<Badge tone={r.request.closedAt ? "neutral" : "primary"}>{r.request.closedAt ? t("quotes.closed") : t("quotes.open")}</Badge>}
      />
      {sp.created && <Alert tone="success">{t("quotes.created")}</Alert>}

      <Card>
        <CardTitle>{t("vendors.quotesTitle")}</CardTitle>
        {r.quotes.length === 0 ? (
          <p className="text-sm text-muted">{t("services.noQuotes")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {r.quotes.map((q) => (
              <li key={q.id}>
                <Link href={`/events/${eventId}/vendors/quotes/${q.id}`} className="flex min-h-11 items-center gap-2 py-1 hover:text-primary">
                  {t("quotes.version", { version: q.version })}
                  {q.vendorRef && <span className="text-muted">#{q.vendorRef}</span>}
                  {q.declinedAt && <Badge>{t("services.declined")}</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="mt-3 flex flex-wrap gap-2 print:hidden">
            {r.quotes.length === 0 && <LinkButton href={`/events/${eventId}/vendors/requests/${requestId}/quote`}>{t("quotes.enterQuote")}</LinkButton>}
            <form action={closeRequestAction.bind(null, eventId, requestId, !r.request.closedAt)}>
              <SubmitButton variant="secondary">{r.request.closedAt ? t("quotes.reopen") : t("quotes.close")}</SubmitButton>
            </form>
          </div>
        )}
      </Card>

      <Card>
        <CardTitle
          action={
            <div className="flex flex-wrap gap-2 print:hidden">
              <a href={wa} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary")}>
                {t("quotes.shareBrief")}
              </a>
              <PrintButton label={t("quotes.printBrief")} />
            </div>
          }
        >
          {t("quotes.brief")}
        </CardTitle>
        <p className="mb-3 text-sm text-muted">{t("quotes.briefIntro")}</p>
        {r.services.map((s) => (
          <section key={s.service.id} className="mb-4 break-inside-avoid">
            <h3 className="font-semibold">
              {s.fn.name}
              {s.fn.date && ` · ${formatDay(locale, s.fn.date)}`} · {serviceLabel(t, { ...s.service, typeKey: s.typeKey, typeName: s.typeName })}
            </h3>
            {s.fn.venueName && <p className="text-sm text-muted">{[s.fn.venueName, s.fn.venueAddress].filter(Boolean).join(", ")}</p>}
            {s.service.brief && <p className="mt-1 whitespace-pre-line text-sm">{s.service.brief}</p>}
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {s.requirements.map((q) => (
                <li key={q.id}>
                  <span className="font-medium">{q.title}</span>
                  {q.quantity != null && ` · ${q.quantity} ${q.unit ?? ""}`}
                  {q.startsAt && ` · ${formatWallClock(locale, q.startsAt, { dateStyle: "medium", timeStyle: "short" })}`}
                  {q.venue && ` · ${q.venue}`}
                  {q.specs && <div className="whitespace-pre-line text-muted">{q.specs}</div>}
                </li>
              ))}
            </ul>
          </section>
        ))}
        {r.request.dueDate && (
          <p className="text-sm">
            {t("quotes.dueDate")}: {formatDay(locale, r.request.dueDate)}
          </p>
        )}
        {r.request.message && <p className="mt-2 whitespace-pre-line text-sm">{r.request.message}</p>}
      </Card>
    </div>
  );
}
