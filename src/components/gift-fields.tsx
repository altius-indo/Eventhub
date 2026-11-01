import type { Gift } from "@/db/schema";
import { MoneyInput } from "./money-fields";
import { Field, Input, Select, Textarea } from "./ui";

export type GiftFieldLabels = {
  household: string;
  householdNone: string;
  giverName: string;
  giverHelp: string;
  type: string;
  types: Record<Gift["type"], string>;
  amount: string;
  amountHelp: string;
  itemDescription: string;
  estValue: string;
  function: string;
  noFunction: string;
  receivedFor: string;
  receivedFors: Record<Gift["receivedFor"], string>;
  receivedForNote: string;
  envelopeNo: string;
  receivedOn: string;
  notes: string;
};

/** Gift register fields (GFT-01). Amount for cash/UPI/cheque; item + estimated value otherwise. */
export function GiftFields({
  labels,
  households,
  functions,
  value,
  today,
}: {
  labels: GiftFieldLabels;
  households: { id: string; name: string }[];
  functions: { id: string; name: string }[];
  value?: Partial<Gift> & { giverName?: string | null };
  today: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.household} htmlFor="gift-household">
          <Select id="gift-household" name="householdId" defaultValue={value?.householdId ?? ""}>
            <option value="">{labels.householdNone}</option>
            {households.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.giverName} htmlFor="gift-giver" hint={labels.giverHelp}>
          <Input id="gift-giver" name="giverName" maxLength={120} defaultValue={value?.householdId ? "" : (value?.giverName ?? "")} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.type} htmlFor="gift-type">
          <Select id="gift-type" name="type" defaultValue={value?.type ?? "cash"}>
            {(Object.keys(labels.types) as Gift["type"][]).map((k) => (
              <option key={k} value={k}>
                {labels.types[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.amount} htmlFor="gift-amount" hint={labels.amountHelp}>
          <MoneyInput id="gift-amount" name="amount" value={value?.amountPaise} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.itemDescription} htmlFor="gift-item">
          <Input id="gift-item" name="itemDescription" maxLength={300} defaultValue={value?.itemDescription ?? ""} />
        </Field>
        <Field label={labels.estValue} htmlFor="gift-est">
          <MoneyInput id="gift-est" name="estValue" value={value?.estValuePaise} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.function} htmlFor="gift-function">
          <Select id="gift-function" name="functionId" defaultValue={value?.functionId ?? ""}>
            <option value="">{labels.noFunction}</option>
            {functions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.envelopeNo} htmlFor="gift-envelope">
          <Input id="gift-envelope" name="envelopeNo" maxLength={20} defaultValue={value?.envelopeNo ?? ""} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.receivedFor} htmlFor="gift-for">
          <Select id="gift-for" name="receivedFor" defaultValue={value?.receivedFor ?? "couple"}>
            {(Object.keys(labels.receivedFors) as Gift["receivedFor"][]).map((k) => (
              <option key={k} value={k}>
                {labels.receivedFors[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.receivedForNote} htmlFor="gift-for-note">
          <Input id="gift-for-note" name="receivedForNote" maxLength={120} defaultValue={value?.receivedForNote ?? ""} />
        </Field>
      </div>
      <Field label={labels.receivedOn} htmlFor="gift-date">
        <Input id="gift-date" name="receivedOn" type="date" defaultValue={value?.receivedOn ?? today} />
      </Field>
      <Field label={labels.notes} htmlFor="gift-notes">
        <Textarea id="gift-notes" name="notes" maxLength={1000} defaultValue={value?.notes ?? ""} />
      </Field>
    </div>
  );
}
