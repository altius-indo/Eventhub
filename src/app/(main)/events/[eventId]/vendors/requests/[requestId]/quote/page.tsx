import { notFound } from "next/navigation";
import { MoneyInput } from "@/components/money-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardTitle, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { isUuid } from "@/lib/ids";
import { suggestGstType } from "@/lib/money";
import { getQuote, getQuoteRequest, QuoteError } from "@/lib/quotes";
import { getVendor } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { saveQuoteAction } from "../../../actions";

/** Entering a vendor's quote (VND-03/04): lines per requirement, service extras and package lines. */
export default async function QuoteEntryPage({ params, searchParams }: PageProps<"/events/[eventId]/vendors/requests/[requestId]/quote">) {
  const { eventId, requestId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("vendors.edit") || !isUuid(requestId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const r = await getQuoteRequest(db, eventId, requestId).catch((e) => {
    if (e instanceof QuoteError) notFound();
    throw e;
  });
  const reviseId = typeof sp.revise === "string" && isUuid(sp.revise) && r.quotes.some((q) => q.id === sp.revise) ? sp.revise : null;
  const prev = reviseId ? await getQuote(db, eventId, reviseId) : null;
  const vendor = await getVendor(db, eventId, r.request.vendorId);
  const taxType = prev?.quote.taxType ?? suggestGstType(vendor.gstin, ctx.event.placeOfSupply);
  const gstRate = prev?.lines[0] ? prev.lines[0].gstRateBps / 100 : 18;
  const reqLine = (id: string) => prev?.lines.find((l) => l.requirementId === id);
  const extra = (id: string) => prev?.lines.find((l) => l.scope === "service" && l.serviceId === id);
  const pkgs = prev?.lines.filter((l) => l.scope === "package") ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title={reviseId ? t("quotes.revise") : t("quotes.enterQuote")} subtitle={r.vendorName} />
      <SimpleForm action={saveQuoteAction.bind(null, eventId, requestId, reviseId)}>
        <Card className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("quotes.vendorRef")} htmlFor="ref">
              <Input id="ref" name="vendorRef" maxLength={80} defaultValue={prev?.quote.vendorRef ?? ""} />
            </Field>
            <Field label={t("quotes.receivedOn")} htmlFor="recv">
              <Input id="recv" name="receivedOn" type="date" defaultValue={eventToday(ctx.event.timezone)} />
            </Field>
            <Field label={t("quotes.validUntil")} htmlFor="valid">
              <Input id="valid" name="validUntil" type="date" defaultValue={prev?.quote.validUntil ?? ""} />
            </Field>
            <Field label={t("quotes.taxType")} htmlFor="tax" hint={t("quotes.suggestedTax")}>
              <Select id="tax" name="taxType" defaultValue={taxType}>
                <option value="none">{t("quotes.taxTypes.none")}</option>
                <option value="cgst_sgst">{t("quotes.taxTypes.cgst_sgst")}</option>
                <option value="igst">{t("quotes.taxTypes.igst")}</option>
              </Select>
            </Field>
            <Field label={t("quotes.gstRate")} htmlFor="rate">
              <Input id="rate" name="gstRate" inputMode="decimal" defaultValue={String(gstRate)} />
            </Field>
          </div>
        </Card>

        {r.services.map((s) => (
          <Card key={s.service.id}>
            <CardTitle>
              {s.fn.name}
              {s.fn.date && ` · ${formatDay(locale, s.fn.date)}`} · {serviceLabel(t, { ...s.service, typeKey: s.typeKey, typeName: s.typeName })}
            </CardTitle>
            <ul className="space-y-3">
              {s.requirements.map((q) => (
                <li key={q.id} className="grid gap-2 sm:grid-cols-[1fr_9rem_10rem] sm:items-end">
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
              <Field label={t("quotes.extras")} htmlFor={`xdesc_${s.service.id}`}>
                <Input id={`xdesc_${s.service.id}`} name={`xdesc_${s.service.id}`} maxLength={300} placeholder={t("quotes.extraDescription")} defaultValue={extra(s.service.id)?.description ?? ""} />
              </Field>
              <Field label={t("quotes.lineAmount")} htmlFor={`xamt_${s.service.id}`}>
                <MoneyInput id={`xamt_${s.service.id}`} name={`xamt_${s.service.id}`} value={extra(s.service.id)?.amountPaise} />
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
        <SubmitButton>{t("quotes.save")}</SubmitButton>
      </SimpleForm>
    </div>
  );
}
