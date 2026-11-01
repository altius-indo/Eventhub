import { Alert, Badge, Card, CardTitle, Field, Input, Select, Textarea, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { MAX_DOCUMENT_MB } from "@/lib/documents";
import { suggestGstType } from "@/lib/money";
import { payTone } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { todayIn } from "@/lib/tasks";
import { listPortalBookings, listPortalInvoices } from "@/lib/vendor-portal";

/** Error codes the upload route may send back, mapped to messages (text is never taken from the URL). */
const ERRORS: Record<string, MessageKey> = {
  "portal.not_found": "vendorPortal.errors.not_found",
  "portal.invalid": "vendorPortal.errors.invalid",
  "pay.duplicate_number": "payments.errors.duplicate_number",
  "pay.invalid_gstin": "payments.errors.invalid_gstin",
  "pay.invalid": "payments.errors.invalid",
  "doc.too_large": "documents.errors.too_large",
  "doc.bad_type": "documents.errors.bad_type",
  "doc.quota": "documents.errors.quota",
  "doc.invalid": "documents.errors.invalid",
};

export default async function PortalInvoices({ params, searchParams }: PageProps<"/vendor/[vendorId]/invoices">) {
  const { vendorId } = await params;
  const sp = await searchParams;
  const ctx = await getVendorContext(vendorId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const today = todayIn(ctx.event.timezone);
  const [rows, bookings] = await Promise.all([listPortalInvoices(db, ctx.event.id, vendorId, today), listPortalBookings(db, ctx.event.id, vendorId)]);
  const live = bookings.filter((b) => b.status !== "cancelled");
  const preselect = typeof sp.booking === "string" && live.some((b) => b.id === sp.booking) ? sp.booking : "";
  const err = typeof sp.err === "string" ? ERRORS[sp.err] : undefined;
  const fileErr = typeof sp.fileErr === "string" ? ERRORS[sp.fileErr] : undefined;
  const inr = (p: number) => formatInr(locale, p);

  return (
    <div className="space-y-4">
      {sp.saved === "1" && !fileErr && <Alert tone="success">{t("vendorPortal.invoices.saved")}</Alert>}
      {fileErr && (
        <Alert tone="warning">
          {t("vendorPortal.invoices.fileFailed")} {t(fileErr, { size: MAX_DOCUMENT_MB })}
        </Alert>
      )}
      {err && <Alert tone="danger">{t(err, { size: MAX_DOCUMENT_MB })}</Alert>}

      <Card>
        <CardTitle>{t("vendorPortal.invoices.title")}</CardTitle>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t("vendorPortal.invoices.empty")}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {rows.map((i) => (
              <li key={i.id} className="flex min-h-11 flex-wrap items-center gap-2 py-1">
                <span className="font-medium">{i.number}</span>
                <span className="text-muted">{formatDay(locale, i.invoiceDate)}</span>
                {i.source === "vendor" && <Badge>{t("vendorPortal.invoices.byYou")}</Badge>}
                <span className="ml-auto">{inr(i.total)}</span>
                <Badge tone={payTone[i.status]}>{t(`payments.status.${i.status}` as MessageKey)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {ctx.can("portal.invoice") && (
        <Card>
          <CardTitle>{t("vendorPortal.invoices.upload")}</CardTitle>
          <p className="mb-3 text-sm text-muted">{t("vendorPortal.invoices.uploadHelp")}</p>
          <form action={`/vendor/${vendorId}/invoices/upload`} method="post" encType="multipart/form-data" className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("vendorPortal.invoices.booking")} htmlFor="inv-booking">
                <Select id="inv-booking" name="bookingId" defaultValue={preselect}>
                  <option value="">{t("vendorPortal.invoices.noBooking")}</option>
                  {live.map((b) => (
                    <option key={b.id} value={b.id}>
                      {[b.functions.map((f) => f.functionName).join(", "), inr(b.total)].filter(Boolean).join(" · ")}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("vendorPortal.invoices.number")} htmlFor="inv-number">
                <Input id="inv-number" name="number" required maxLength={60} />
              </Field>
              <Field label={t("vendorPortal.invoices.date")} htmlFor="inv-date">
                <Input id="inv-date" name="invoiceDate" type="date" required defaultValue={today} />
              </Field>
              <Field label={t("vendorPortal.invoices.due")} htmlFor="inv-due">
                <Input id="inv-due" name="dueDate" type="date" />
              </Field>
              <Field label={t("vendorPortal.invoices.description")} htmlFor="inv-desc">
                <Input id="inv-desc" name="description" required maxLength={300} />
              </Field>
              <Field label={t("vendorPortal.invoices.amount")} htmlFor="inv-amount">
                <Input id="inv-amount" name="amount" required inputMode="decimal" />
              </Field>
              <Field label={t("quotes.taxType")} htmlFor="inv-tax">
                <Select id="inv-tax" name="taxType" defaultValue={suggestGstType(ctx.vendor.gstin, ctx.event.placeOfSupply)}>
                  <option value="none">{t("quotes.taxTypes.none")}</option>
                  <option value="cgst_sgst">{t("quotes.taxTypes.cgst_sgst")}</option>
                  <option value="igst">{t("quotes.taxTypes.igst")}</option>
                </Select>
              </Field>
              <Field label={t("vendorPortal.invoices.gstRate")} htmlFor="inv-rate">
                <Input id="inv-rate" name="gstRate" inputMode="decimal" defaultValue="18" />
              </Field>
              <Field label={t("vendorPortal.invoices.gstin")} htmlFor="inv-gstin">
                <Input id="inv-gstin" name="supplierGstin" maxLength={15} autoCapitalize="characters" defaultValue={ctx.vendor.gstin ?? ""} />
              </Field>
              <Field label={t("vendorPortal.invoices.file")} htmlFor="inv-file" hint={t("documents.help", { size: MAX_DOCUMENT_MB })}>
                <Input id="inv-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,.heic" className="py-2" />
              </Field>
            </div>
            <Field label={t("vendorPortal.invoices.notes")} htmlFor="inv-notes">
              <Textarea id="inv-notes" name="notes" rows={2} maxLength={2000} />
            </Field>
            <button type="submit" className={buttonClass("primary")}>
              {t("vendorPortal.invoices.upload")}
            </button>
          </form>
        </Card>
      )}
    </div>
  );
}
