import type { Vendor } from "@/db/schema";
import { Field, Input, Textarea } from "./ui";

export type VendorLabels = Record<"name" | "contactName" | "phone" | "email" | "gstin" | "gstinHelp" | "services" | "notes", string>;

export function VendorFields({ labels, value, types, selected }: { labels: VendorLabels; value?: Vendor; types: { id: string; label: string }[]; selected?: string[] }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.name} htmlFor="v-name">
          <Input id="v-name" name="name" required maxLength={120} defaultValue={value?.name} />
        </Field>
        <Field label={labels.contactName} htmlFor="v-contact">
          <Input id="v-contact" name="contactName" maxLength={120} defaultValue={value?.contactName ?? ""} />
        </Field>
        <Field label={labels.phone} htmlFor="v-phone">
          <Input id="v-phone" name="phone" type="tel" maxLength={30} defaultValue={value?.phone ?? ""} />
        </Field>
        <Field label={labels.email} htmlFor="v-email">
          <Input id="v-email" name="email" type="email" maxLength={200} defaultValue={value?.email ?? ""} />
        </Field>
        <Field label={labels.gstin} htmlFor="v-gstin" hint={labels.gstinHelp}>
          <Input id="v-gstin" name="gstin" maxLength={15} autoCapitalize="characters" defaultValue={value?.gstin ?? ""} />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{labels.services}</legend>
        <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-3">
          {types.map((ty) => (
            <label key={ty.id} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="serviceTypeIds" value={ty.id} defaultChecked={selected?.includes(ty.id)} className="h-5 w-5" />
              {ty.label}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={labels.notes} htmlFor="v-notes">
        <Textarea id="v-notes" name="notes" rows={2} maxLength={2000} defaultValue={value?.notes ?? ""} />
      </Field>
    </div>
  );
}
