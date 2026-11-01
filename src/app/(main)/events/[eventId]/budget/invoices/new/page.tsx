import { notFound } from "next/navigation";
import { MoneyInput } from "@/components/money-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardTitle, Field, Input, PageHeader, Select, Textarea, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatInr } from "@/i18n/core";
import { getBooking, listBookings } from "@/lib/bookings";
import { isUuid } from "@/lib/ids";
import { suggestGstType } from "@/lib/money";
import { listServices } from "@/lib/services";
import { getVendor, listVendors } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { createInvoiceAction } from "../../actions";

/** PAY-01: an invoice with GST lines, allocated to services (VND-08). */
export default async function NewInvoicePage({ params, searchParams }: PageProps<"/events/[eventId]/budget/invoices/new">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("invoices.edit")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const bookingId = typeof sp.booking === "string" && isUuid(sp.booking) ? sp.booking : null;
  const booking = bookingId ? await getBooking(db, eventId, bookingId).catch(() => null) : null;
  const vendorId = booking?.vendor.id ?? (typeof sp.vendor === "string" && isUuid(sp.vendor) ? sp.vendor : null);

  if (!vendorId) {
    const vendors = await listVendors(db, eventId);
    return (
      <div className="max-w-xl space-y-4">
        <PageHeader title={t("invoices.add")} />
        <Card>
          <form className="flex flex-wrap items-end gap-2">
            <Field label={t("invoices.pickVendor")} htmlFor="pick-v">
              <Select id="pick-v" name="vendor" required>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <button type="submit" className={buttonClass("primary")}>
              {t("common.continue")}
            </button>
          </form>
        </Card>
      </div>
    );
  }

  const vendor = await getVendor(db, eventId, vendorId).catch(() => notFound());
  const [bookings, services] = await Promise.all([listBookings(db, eventId, { vendorId }), listServices(db, eventId)]);
  const svcIds = booking ? new Set(booking.fulfilments.map((f) => f.f.serviceId)) : null;
  const svcOptions = services.filter((s) => !svcIds || svcIds.has(s.id));
  const taxType = suggestGstType(vendor.gstin, ctx.event.placeOfSupply);
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title={t("invoices.add")} subtitle={vendor.name} />
      <SimpleForm action={createInvoiceAction.bind(null, eventId)}>
        <input type="hidden" name="vendorId" value={vendor.id} />
        <Card className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("invoices.number")} htmlFor="inv-no">
              <Input id="inv-no" name="number" required maxLength={60} />
            </Field>
            <Field label={t("invoices.date")} htmlFor="inv-date">
              <Input id="inv-date" name="invoiceDate" type="date" required defaultValue={eventToday(ctx.event.timezone)} />
            </Field>
            <Field label={t("invoices.dueDate")} htmlFor="inv-due">
              <Input id="inv-due" name="dueDate" type="date" />
            </Field>
            <Field label={t("invoices.booking")} htmlFor="inv-bk">
              <Select id="inv-bk" name="bookingId" defaultValue={booking?.booking.id ?? ""}>
                <option value="">{t("invoices.noBooking")}</option>
                {bookings.map((b) => (
                  <option key={b.booking.id} value={b.booking.id}>
                    {formatInr(locale, b.booking.subtotalPaise + b.booking.gstPaise)} · {t(`bookings.status.${b.booking.status}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("quotes.taxType")} htmlFor="inv-tax" hint={t("quotes.suggestedTax")}>
              <Select id="inv-tax" name="taxType" defaultValue={taxType}>
                <option value="none">{t("quotes.taxTypes.none")}</option>
                <option value="cgst_sgst">{t("quotes.taxTypes.cgst_sgst")}</option>
                <option value="igst">{t("quotes.taxTypes.igst")}</option>
              </Select>
            </Field>
            <Field label={t("invoices.supplierGstin")} htmlFor="inv-gstin">
              <Input id="inv-gstin" name="supplierGstin" maxLength={15} defaultValue={vendor.gstin ?? ""} autoCapitalize="characters" />
            </Field>
          </div>
        </Card>
        <Card className="space-y-3">
          <CardTitle>{t("invoices.lines")}</CardTitle>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 border-b border-border pb-3 last:border-0 sm:grid-cols-[2fr_2fr_6rem_9rem_5rem]">
              <Field label={t("invoices.description")} htmlFor={`desc_${i}`}>
                <Input id={`desc_${i}`} name={`desc_${i}`} maxLength={300} />
              </Field>
              <Field label={t("invoices.lineService")} htmlFor={`svc_${i}`}>
                <Select id={`svc_${i}`} name={`svc_${i}`} defaultValue="">
                  <option value="">{t("invoices.spread")}</option>
                  {svcOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {serviceLabel(t, s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("invoices.hsnSac")} htmlFor={`hsn_${i}`}>
                <Input id={`hsn_${i}`} name={`hsn_${i}`} maxLength={10} inputMode="numeric" />
              </Field>
              <Field label={t("quotes.lineAmount")} htmlFor={`amount_${i}`}>
                <MoneyInput id={`amount_${i}`} name={`amount_${i}`} allowNegative />
              </Field>
              <Field label={t("quotes.gstRate")} htmlFor={`rate_${i}`}>
                <Input id={`rate_${i}`} name={`rate_${i}`} inputMode="decimal" defaultValue={taxType === "none" ? "0" : "18"} />
              </Field>
            </div>
          ))}
        </Card>
        <Card className="space-y-3">
          <Field label={t("invoices.printedTotal")} htmlFor="inv-total" hint={t("invoices.printedTotalHelp")}>
            <MoneyInput id="inv-total" name="printedTotal" />
          </Field>
          <Field label={t("payments.notes")} htmlFor="inv-notes">
            <Textarea id="inv-notes" name="notes" rows={2} maxLength={2000} />
          </Field>
        </Card>
        <SubmitButton>{t("common.save")}</SubmitButton>
      </SimpleForm>
    </div>
  );
}
