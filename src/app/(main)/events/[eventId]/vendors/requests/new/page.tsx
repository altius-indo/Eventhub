import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { isUuid } from "@/lib/ids";
import { listServices } from "@/lib/services";
import { listVendors } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { serviceLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { createRequestsAction } from "../../actions";

/** VND-02: one request per vendor for one or more services, across functions and types. */
export default async function NewRequestPage({ params, searchParams }: PageProps<"/events/[eventId]/vendors/requests/new">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("vendors.edit")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const [fns, services, vendors] = await Promise.all([listFunctions(db, eventId), listServices(db, eventId), listVendors(db, eventId)]);
  const pre = typeof sp.service === "string" && isUuid(sp.service) ? sp.service : null;
  const preVendor = typeof sp.vendor === "string" && isUuid(sp.vendor) ? sp.vendor : null;
  const preType = services.find((s) => s.id === pre)?.serviceTypeId;
  const quotable = services.filter((s) => s.approvalState === "approved" && !s.cancelledAt);
  // Vendors offering the pre-selected service type first.
  const sorted = [...vendors].sort((a, b) => Number(!!preType && b.typeIds.includes(preType)) - Number(!!preType && a.typeIds.includes(preType)));
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title={t("quotes.newRequest")} subtitle={t("quotes.requestHelp")} />
      <SimpleForm action={createRequestsAction.bind(null, eventId)}>
        <Card>
          <fieldset>
            <legend className="mb-2 font-semibold">{t("quotes.pickServices")}</legend>
            {fns.map((fn) => {
              const list = quotable.filter((s) => s.functionId === fn.id);
              if (list.length === 0) return null;
              return (
                <div key={fn.id} className="mb-3">
                  <p className="text-sm text-muted">
                    {fn.name}
                    {fn.date && ` · ${formatDay(locale, fn.date)}`}
                  </p>
                  {list.map((s) => (
                    <label key={s.id} className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="serviceIds" value={s.id} defaultChecked={s.id === pre} className="h-5 w-5" />
                      {serviceLabel(t, s)}
                    </label>
                  ))}
                </div>
              );
            })}
            {quotable.length === 0 && <p className="text-sm text-muted">{t("services.empty")}</p>}
          </fieldset>
        </Card>
        <Card>
          <fieldset>
            <legend className="mb-2 font-semibold">{t("quotes.pickVendors")}</legend>
            {sorted.length === 0 && <p className="text-sm text-muted">{t("quotes.noVendorsForType")}</p>}
            <div className="grid sm:grid-cols-2">
              {sorted.map((v) => (
                <label key={v.id} className="flex min-h-11 items-center gap-2">
                  <input type="checkbox" name="vendorIds" value={v.id} defaultChecked={v.id === preVendor} className="h-5 w-5" />
                  <span className={preType && v.typeIds.includes(preType) ? "font-medium" : ""}>{v.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </Card>
        <Card className="space-y-3">
          <Field label={t("quotes.dueDate")} htmlFor="due">
            <Input id="due" name="dueDate" type="date" />
          </Field>
          <Field label={t("quotes.message")} htmlFor="msg">
            <Textarea id="msg" name="message" rows={3} maxLength={2000} />
          </Field>
        </Card>
        <SubmitButton>{t("quotes.send")}</SubmitButton>
      </SimpleForm>
    </div>
  );
}
