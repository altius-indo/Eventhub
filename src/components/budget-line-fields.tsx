import type { BudgetLine } from "@/db/schema";
import { MoneyInput, PayerFields, type PayerLabels } from "./money-fields";
import { Field, Input, Select, Textarea } from "./ui";

export type BudgetLineLabels = Record<"title" | "category" | "function" | "anyFunction" | "estimate" | "notes", string> & { payer: PayerLabels };

export function BudgetLineFields({
  labels,
  value,
  id,
  categories,
  functions,
}: {
  labels: BudgetLineLabels;
  value?: BudgetLine;
  id: string;
  categories: { id: string; label: string }[];
  functions: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.title} htmlFor={`${id}-title`}>
          <Input id={`${id}-title`} name="title" required maxLength={200} defaultValue={value?.title} />
        </Field>
        <Field label={labels.estimate} htmlFor={`${id}-est`}>
          <MoneyInput id={`${id}-est`} name="estimate" value={value?.estimatePaise} required />
        </Field>
        <Field label={labels.category} htmlFor={`${id}-cat`}>
          <Select id={`${id}-cat`} name="categoryId" defaultValue={value?.categoryId}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.function} htmlFor={`${id}-fn`}>
          <Select id={`${id}-fn`} name="functionId" defaultValue={value?.functionId ?? ""}>
            <option value="">{labels.anyFunction}</option>
            {functions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <PayerFields labels={labels.payer} value={value?.payer} id={`${id}-payer`} />
      <Field label={labels.notes} htmlFor={`${id}-notes`}>
        <Textarea id={`${id}-notes`} name="notes" rows={2} maxLength={2000} defaultValue={value?.notes ?? ""} />
      </Field>
    </div>
  );
}
