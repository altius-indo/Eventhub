import type { Household } from "@/db/schema";
import { Field, Input, Select, Textarea } from "./ui";

export type HouseholdFieldLabels = Record<
  "name" | "namePlaceholder" | "side" | "bride" | "groom" | "both" | "address" | "city" | "postalCode" | "notes",
  string
>;

export function HouseholdFields({ labels, household }: { labels: HouseholdFieldLabels; household?: Partial<Household> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={labels.name} htmlFor="householdName">
        <Input id="householdName" name="householdName" required maxLength={120} placeholder={labels.namePlaceholder} defaultValue={household?.name ?? ""} />
      </Field>
      <Field label={labels.side} htmlFor="side">
        <Select id="side" name="side" defaultValue={household?.side ?? "both"}>
          <option value="bride">{labels.bride}</option>
          <option value="groom">{labels.groom}</option>
          <option value="both">{labels.both}</option>
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <Field label={labels.address} htmlFor="address">
          <Textarea id="address" name="address" rows={2} maxLength={400} defaultValue={household?.address ?? ""} />
        </Field>
      </div>
      <Field label={labels.city} htmlFor="city">
        <Input id="city" name="city" maxLength={80} defaultValue={household?.city ?? ""} />
      </Field>
      <Field label={labels.postalCode} htmlFor="postalCode">
        <Input id="postalCode" name="postalCode" inputMode="numeric" maxLength={20} defaultValue={household?.postalCode ?? ""} />
      </Field>
      <div className="sm:col-span-2">
        <Field label={labels.notes} htmlFor="notes">
          <Textarea id="notes" name="notes" rows={2} maxLength={2000} defaultValue={household?.notes ?? ""} />
        </Field>
      </div>
    </div>
  );
}
