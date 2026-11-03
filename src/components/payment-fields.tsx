import { MoneyInput, PayerFields, type PayerLabels } from "./money-fields";
import { Field, Input, Select, Textarea } from "./ui";

export type PaymentLabels = Record<"paidOn" | "amount" | "mode" | "reference" | "invoice" | "noInvoice" | "notes" | "allowOverpay", string> & {
  modes: Record<"upi" | "bank" | "cheque" | "cash" | "card", string>;
  payer: PayerLabels;
};

/** PAY-03 fields. Cash payments to a pandit or mehendi artist often have no reference: it's optional. */
export function PaymentFields({ labels, today, invoices, id, overpay }: { labels: PaymentLabels; today: string; invoices: { id: string; label: string }[]; id: string; overpay: boolean }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={labels.paidOn} htmlFor={`${id}-on`}>
          <Input id={`${id}-on`} name="paidOn" type="date" required defaultValue={today} />
        </Field>
        <Field label={labels.amount} htmlFor={`${id}-amt`}>
          <MoneyInput id={`${id}-amt`} name="amount" required />
        </Field>
        <Field label={labels.mode} htmlFor={`${id}-mode`}>
          <Select id={`${id}-mode`} name="mode" defaultValue="upi">
            {(Object.keys(labels.modes) as (keyof PaymentLabels["modes"])[]).map((m) => (
              <option key={m} value={m}>
                {labels.modes[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.reference} htmlFor={`${id}-ref`}>
          <Input id={`${id}-ref`} name="reference" maxLength={100} />
        </Field>
        {invoices.length > 0 && (
          <Field label={labels.invoice} htmlFor={`${id}-inv`}>
            <Select id={`${id}-inv`} name="invoiceId" defaultValue="">
              <option value="">{labels.noInvoice}</option>
              {invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <PayerFields labels={labels.payer} id={`${id}-payer`} />
      <Field label={labels.notes} htmlFor={`${id}-notes`}>
        <Textarea id={`${id}-notes`} name="notes" rows={2} maxLength={1000} />
      </Field>
      {overpay && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="allowOverpay" className="h-5 w-5" />
          {labels.allowOverpay}
        </label>
      )}
    </div>
  );
}
