import { notFound } from "next/navigation";
import { MoneyInput } from "@/components/money-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, formatTime, formatWallClock } from "@/i18n/core";
import { isUuid } from "@/lib/ids";
import { suggestGstType } from "@/lib/money";
import { serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { getPortalRequest, PortalError } from "@/lib/vendor-portal";
import { submitQuoteAction } from "../../actions";

/** A quote request's brief (VND-02) with the vendor's quotes and the quote form (VND-03/07/10). */
export default async function PortalRequest({ params, searchParams }: PageProps<"/vendor/[vendorId]/requests/[requestId]">) {
  const { vendorId, requestId } = await params;
  const sp = await searchParams;
  const ctx = await getVendorContext(vendorId);
  if (!isUuid(requestId)) notFound();
  const { t, locale } = await getTranslator();
  const r = await getPortalRequest(getDb(), ctx.event.id, vendorId, requestId).catch((e) => {
    if (e instanceof PortalError) notFound();
    throw e;
  });
  const inr = (p: number) => formatInr(locale, p);
  const prev = r.quotes.find((q) => q.latest) ?? null;
  const reqTitle = new Map(r.services.flatMap((s) => s.requirements.map((q) => [q.id, q.title] as const)));
  const svcName = new Map(r.services.map((s) => [s.id, `${s.fn.name} · ${serviceLabel(t, s)}`] as const));
  const reqLine = (id: string) => prev?.lines.find((l) => l.requirementId === id);
  const extra = (id: string) => prev?.lines.find((l) => l.scope === "service" && l.serviceId === id);
  const pkgs = prev?.lines.filter((l) => l.scope === "package") ?? [];
  const canQuote = ctx.can("portal.quote") && !r.request.closed;

  return (
    <div className="space-y-4">
      {sp.sent === "1" && <Alert tone="success">{t("vendorPortal.requests.quoteSent")}</Alert>}
      {r.request.closed && <Alert tone="neutral">{t("vendorPortal.requests.closedHelp")}</Alert>}
      {r.request.message && (
        <Card>
          <CardTitle>{t("vendorPortal.requests.message")}</CardTitle>
          <p className="whitespace-pre-line text-sm">{r.request.message}</p>
          {r.request.dueDate && <p className="mt-2 text-sm text-muted">{t("vendorPortal.requests.dueBy", { date: formatDay(locale, r.request.dueDate) })}</p>}
        </Card>
      )}

      {r.services.map((s) => (
        <Card key={s.id}>
          <CardTitle>
            {s.fn.name} · {serviceLabel(t, s)}
          </CardTitle>
          {s.cancelled && <Alert tone="warning">{t("vendorPortal.requests.serviceCancelled")}</Alert>}
          <dl className="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted">{t("vendorPortal.requests.when")}</dt>
            <dd>{[s.fn.date && formatDay(locale, s.fn.date, { dateStyle: "full" }), s.fn.startTime && formatTime(locale, s.fn.startTime)].filter(Boolean).join(" · ") || "—"}</dd>
            <dt className="text-muted">{t("vendorPortal.requests.venue")}</dt>
            <dd>
              {[s.fn.venueName, s.fn.venueAddress].filter(Boolean).join(", ") || "—"}
              {s.fn.mapUrl && /^https?:\/\//.test(s.fn.mapUrl) && (
                <>
                  {" · "}
                  <a href={s.fn.mapUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                    {t("vendorPortal.requests.map")}
                  </a>
                </>
              )}
            </dd>
          </dl>
          {s.brief && <p className="mt-2 whitespace-pre-line text-sm">{s.brief}</p>}
          <h3 className="mt-3 text-sm font-semibold">{t("vendorPortal.requests.requirements")}</h3>
          {s.requirements.length === 0 ? (
            <p className="text-sm text-muted">{t("vendorPortal.requests.noRequirements")}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {s.requirements.map((q) => (
                <li key={q.id} className="py-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{q.title}</span>
                    {q.quantity != null && (
                      <span>
                        {q.quantity} {q.unit ?? ""}
                      </span>
                    )}
                    <Badge tone={q.priority === "must" ? "primary" : "neutral"}>{t(`vendorPortal.requests.priority.${q.priority}`)}</Badge>
                  </p>
                  {q.specs && <p className="whitespace-pre-line text-muted">{q.specs}</p>}
                  {(q.startsAt || q.venue) && (
                    <p className="text-muted">{[q.startsAt && formatWallClock(locale, q.startsAt), q.endsAt && formatWallClock(locale, q.endsAt, { timeStyle: "short" }), q.venue].filter(Boolean).join(" · ")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      {r.quotes.length > 0 && (
        <Card>
          <CardTitle>{t("vendorPortal.requests.yourQuotes")}</CardTitle>
          <div className="space-y-4">
            {r.quotes.map((q) => (
              <details key={q.quote.id} open={q.latest} className="rounded-lg border border-border p-3">
                <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{t("quotes.version", { version: q.quote.version })}</span>
                  <span className="text-muted">{formatDay(locale, q.quote.createdAt.toISOString().slice(0, 10))}</span>
                  <Badge>{q.quote.submittedByVendor ? t("vendorPortal.requests.byYou") : t("vendorPortal.requests.byTeam")}</Badge>
                  {q.latest && <Badge tone="primary">{t("vendorPortal.requests.latest")}</Badge>}
                  <span className="ml-auto font-semibold">{inr(q.total)}</span>
                </summary>
                <ul className="mt-2 divide-y divide-border text-sm">
                  {q.lines.map((l) => (
                    <li key={l.id} className="flex flex-wrap justify-between gap-2 py-1">
                      <span>
                        {l.requirementId ? reqTitle.get(l.requirementId) : (l.description ?? t("quotes.package"))}
                        {l.serviceId && <span className="text-muted"> · {svcName.get(l.serviceId)}</span>}
                        {l.quantity != null && ` × ${l.quantity}`}
                      </span>
                      <span>{inr(l.amountPaise)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-right text-sm text-muted">
                  {t("quotes.taxType")} {inr(q.gst)} · {t("quotes.total")} {inr(q.total)}
                </p>
              </details>
            ))}
          </div>
        </Card>
      )}

      {canQuote && (
        <SimpleForm action={submitQuoteAction.bind(null, vendorId, requestId, prev?.quote.id ?? null)}>
          <Card className="space-y-3">
            <CardTitle>{prev ? t("vendorPortal.requests.reviseQuote") : t("vendorPortal.requests.sendQuote")}</CardTitle>
            <p className="text-sm text-muted">{t("vendorPortal.requests.quoteHelp")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("quotes.vendorRef")} htmlFor="ref">
                <Input id="ref" name="vendorRef" maxLength={80} defaultValue={prev?.quote.vendorRef ?? ""} />
              </Field>
              <Field label={t("quotes.validUntil")} htmlFor="valid">
                <Input id="valid" name="validUntil" type="date" defaultValue={prev?.quote.validUntil ?? ""} />
              </Field>
              <Field label={t("quotes.taxType")} htmlFor="tax">
                <Select id="tax" name="taxType" defaultValue={prev?.quote.taxType ?? suggestGstType(ctx.vendor.gstin, ctx.event.placeOfSupply)}>
                  <option value="none">{t("quotes.taxTypes.none")}</option>
                  <option value="cgst_sgst">{t("quotes.taxTypes.cgst_sgst")}</option>
                  <option value="igst">{t("quotes.taxTypes.igst")}</option>
                </Select>
              </Field>
              <Field label={t("quotes.gstRate")} htmlFor="rate">
                <Input id="rate" name="gstRate" inputMode="decimal" defaultValue={String(prev?.lines[0] ? prev.lines[0].gstRateBps / 100 : 18)} />
              </Field>
            </div>
          </Card>

          {r.services
            .filter((s) => !s.cancelled)
            .map((s) => (
              <Card key={s.id}>
                <CardTitle>
                  {s.fn.name} · {serviceLabel(t, s)}
                </CardTitle>
                <ul className="space-y-3">
                  {s.requirements.map((q) => (
                    <li key={q.id} className="grid gap-2 sm:grid-cols-[1fr_8rem_10rem] sm:items-end">
                      <p className="text-sm">
                        <span className="font-medium">{q.title}</span>
                        {q.quantity != null && (
                          <span className="text-muted">
                            {" "}
                            · {q.quantity} {q.unit ?? ""}
                          </span>
                        )}
                      </p>
                      <Field label={t("quotes.lineQty")} htmlFor={`qty_${q.id}`}>
                        <Input id={`qty_${q.id}`} name={`qty_${q.id}`} inputMode="numeric" pattern="[0-9]*" defaultValue={reqLine(q.id)?.quantity ?? ""} />
                      </Field>
                      <Field label={t("quotes.lineAmount")} htmlFor={`amt_${q.id}`}>
                        <MoneyInput id={`amt_${q.id}`} name={`amt_${q.id}`} value={reqLine(q.id)?.amountPaise} />
                      </Field>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-muted">{t("quotes.lineQtyHelp")}</p>
                <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-[1fr_10rem]">
                  <Field label={t("quotes.extras")} htmlFor={`xdesc_${s.id}`}>
                    <Input id={`xdesc_${s.id}`} name={`xdesc_${s.id}`} maxLength={300} placeholder={t("quotes.extraDescription")} defaultValue={extra(s.id)?.description ?? ""} />
                  </Field>
                  <Field label={t("quotes.lineAmount")} htmlFor={`xamt_${s.id}`}>
                    <MoneyInput id={`xamt_${s.id}`} name={`xamt_${s.id}`} value={extra(s.id)?.amountPaise} />
                  </Field>
                </div>
              </Card>
            ))}

          <Card className="space-y-3">
            <CardTitle>{t("quotes.package")}</CardTitle>
            <p className="text-sm text-muted">{t("quotes.packageHelp")}</p>
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[1fr_10rem] sm:items-end">
                <Field label={t("quotes.extraDescription")} htmlFor={`pdesc_${i}`}>
                  <Input id={`pdesc_${i}`} name={`pdesc_${i}`} maxLength={300} defaultValue={pkgs[i]?.description ?? ""} />
                </Field>
                <Field label={t("quotes.lineAmount")} htmlFor={`pamt_${i}`}>
                  <MoneyInput id={`pamt_${i}`} name={`pamt_${i}`} value={pkgs[i]?.amountPaise} allowNegative />
                </Field>
                <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" name={`pcond_${i}`} defaultChecked={pkgs[i]?.conditional} className="h-5 w-5" />
                  {t("quotes.conditional")}
                </label>
              </div>
            ))}
            <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="allOrNothing" defaultChecked={prev?.quote.allOrNothing} className="h-5 w-5" />
                {t("quotes.allOrNothing")}
              </label>
              <Field label={t("quotes.minFunctions")} htmlFor="minfn">
                <Input id="minfn" name="minFunctions" inputMode="numeric" pattern="[0-9]*" defaultValue={prev?.quote.minFunctions ?? ""} />
              </Field>
            </div>
            <Field label={t("quotes.terms")} htmlFor="terms">
              <Textarea id="terms" name="terms" rows={3} maxLength={4000} defaultValue={prev?.quote.terms ?? ""} />
            </Field>
          </Card>
          <SubmitButton>{t("vendorPortal.requests.send")}</SubmitButton>
        </SimpleForm>
      )}
    </div>
  );
}
