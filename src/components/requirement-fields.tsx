import type { Requirement } from "@/db/schema";
import { toWallClockInput } from "@/lib/wall-clock";
import { MoneyInput, PayerFields, type PayerLabels } from "./money-fields";
import { Field, Input, Select, Textarea } from "./ui";

export type RequirementLabels = Record<
  "title" | "quantity" | "unit" | "specs" | "startsAt" | "endsAt" | "timesHelp" | "venue" | "venueHelp" | "estimate" | "priority" | "must" | "nice",
  string
> & { payer: PayerLabels };

/** Fields of a requirement (SVC-04); also used for editing. */
export function RequirementFields({ labels, value, id }: { labels: RequirementLabels; value?: Requirement; id: string }) {
  return (
    <div className="space-y-3">
      <Field label={labels.title} htmlFor={`${id}-title`}>
        <Input id={`${id}-title`} name="title" required maxLength={200} defaultValue={value?.title} />
      </Field>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={labels.quantity} htmlFor={`${id}-qty`}>
          <Input id={`${id}-qty`} name="quantity" inputMode="numeric" pattern="[0-9]*" defaultValue={value?.quantity ?? ""} />
        </Field>
        <Field label={labels.unit} htmlFor={`${id}-unit`}>
          <Input id={`${id}-unit`} name="unit" maxLength={40} defaultValue={value?.unit ?? ""} />
        </Field>
        <Field label={labels.estimate} htmlFor={`${id}-est`}>
          <MoneyInput id={`${id}-est`} name="estimate" value={value?.estimatePaise} />
        </Field>
        <Field label={labels.priority} htmlFor={`${id}-prio`}>
          <Select id={`${id}-prio`} name="priority" defaultValue={value?.priority ?? "must"}>
            <option value="must">{labels.must}</option>
            <option value="nice">{labels.nice}</option>
          </Select>
        </Field>
      </div>
      <Field label={labels.specs} htmlFor={`${id}-specs`}>
        <Textarea id={`${id}-specs`} name="specs" rows={2} maxLength={4000} defaultValue={value?.specs ?? ""} />
      </Field>
      <details>
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-muted">
          {labels.startsAt} / {labels.venue}
        </summary>
        <div className="grid gap-3 pt-2 sm:grid-cols-3">
          <Field label={labels.startsAt} htmlFor={`${id}-start`} hint={labels.timesHelp}>
            <Input id={`${id}-start`} name="startsAt" type="datetime-local" defaultValue={toWallClockInput(value?.startsAt)} />
          </Field>
          <Field label={labels.endsAt} htmlFor={`${id}-end`}>
            <Input id={`${id}-end`} name="endsAt" type="datetime-local" defaultValue={toWallClockInput(value?.endsAt)} />
          </Field>
          <Field label={labels.venue} htmlFor={`${id}-venue`} hint={labels.venueHelp}>
            <Input id={`${id}-venue`} name="venue" maxLength={300} defaultValue={value?.venue ?? ""} />
          </Field>
        </div>
        <div className="pt-2">
          <PayerFields labels={labels.payer} value={value?.payer} id={`${id}-payer`} />
        </div>
      </details>
    </div>
  );
}
