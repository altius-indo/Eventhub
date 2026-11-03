import type { Payer } from "@/db/schema";
import { paiseToRupeesInput } from "@/lib/money";
import { Field, Input, Select } from "./ui";

export type PayerLabels = Record<"label" | "none" | "bride" | "groom" | "shared" | "splitPercent" | "splitFixed" | "brideShare" | "brideShareHelp", string>;

/** Who pays (BGT-03): bride's family, groom's family, or shared by % or a fixed amount. */
export function PayerFields({ labels, value, prefix = "payer", id }: { labels: PayerLabels; value?: Payer | null; prefix?: string; id: string }) {
  const kind = value?.kind ?? "";
  const mode = value?.kind === "shared" ? value.mode : "percent";
  const amount = value?.kind === "shared" ? (value.mode === "percent" ? String(value.brideBps / 100) : paiseToRupeesInput(value.bridePaise)) : "";
  return (
    <fieldset className="grid gap-3 sm:grid-cols-3">
      <Field label={labels.label} htmlFor={`${id}-kind`}>
        <Select id={`${id}-kind`} name={`${prefix}Kind`} defaultValue={kind}>
          <option value="">{labels.none}</option>
          <option value="bride">{labels.bride}</option>
          <option value="groom">{labels.groom}</option>
          <option value="shared">{labels.shared}</option>
        </Select>
      </Field>
      <Field label={labels.shared} htmlFor={`${id}-mode`}>
        <Select id={`${id}-mode`} name={`${prefix}Mode`} defaultValue={mode}>
          <option value="percent">{labels.splitPercent}</option>
          <option value="fixed">{labels.splitFixed}</option>
        </Select>
      </Field>
      <Field label={labels.brideShare} htmlFor={`${id}-value`} hint={labels.brideShareHelp}>
        <Input id={`${id}-value`} name={`${prefix}Value`} inputMode="decimal" defaultValue={amount} />
      </Field>
    </fieldset>
  );
}

/** Rupee amount input (paise in, rupees shown). */
export function MoneyInput({ id, name, value, required, allowNegative }: { id: string; name: string; value?: number | null; required?: boolean; allowNegative?: boolean }) {
  return (
    <div className="relative">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
        ₹
      </span>
      <Input
        id={id}
        name={name}
        inputMode="decimal"
        required={required}
        pattern={allowNegative ? "-?[0-9,]*(\\.[0-9]{1,2})?" : "[0-9,]*(\\.[0-9]{1,2})?"}
        defaultValue={paiseToRupeesInput(value ?? null)}
        className="pl-7"
      />
    </div>
  );
}
