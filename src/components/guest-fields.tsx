import type { Guest } from "@/db/schema";
import { Field, Input, Select } from "./ui";

export type GuestFieldLabels = Record<
  | "name"
  | "relation"
  | "relationPlaceholder"
  | "ageGroup"
  | "phone"
  | "email"
  | "diet"
  | "dietNotSet"
  | "dietNotes"
  | "accessibility"
  | "tags"
  | "tagsHelp"
  | "adult"
  | "child"
  | "infant"
  | "veg"
  | "non_veg"
  | "jain"
  | "vegan"
  | "other",
  string
>;

/** Inputs for one guest. `prefix` namespaces the field names when a form has several guests. */
export function GuestFields({
  labels,
  prefix = "",
  idBase,
  guest,
  compact,
}: {
  labels: GuestFieldLabels;
  prefix?: string;
  /** Unique element-id prefix when several guest forms share a page (defaults to `prefix`). */
  idBase?: string;
  guest?: Partial<Guest>;
  compact?: boolean;
}) {
  const id = (f: string) => `${idBase ?? prefix}${f}`;
  const name = (f: string) => `${prefix}${f}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={labels.name} htmlFor={id("name")}>
        <Input id={id("name")} name={name("name")} required maxLength={120} defaultValue={guest?.name ?? ""} autoComplete="off" />
      </Field>
      <Field label={labels.relation} htmlFor={id("relation")}>
        <Input id={id("relation")} name={name("relation")} maxLength={80} placeholder={labels.relationPlaceholder} defaultValue={guest?.relation ?? ""} />
      </Field>
      <Field label={labels.phone} htmlFor={id("phone")}>
        <Input id={id("phone")} name={name("phone")} type="tel" inputMode="tel" defaultValue={guest?.phone ?? ""} autoComplete="off" />
      </Field>
      <Field label={labels.email} htmlFor={id("email")}>
        <Input id={id("email")} name={name("email")} type="email" defaultValue={guest?.email ?? ""} autoComplete="off" />
      </Field>
      <Field label={labels.ageGroup} htmlFor={id("ageGroup")}>
        <Select id={id("ageGroup")} name={name("ageGroup")} defaultValue={guest?.ageGroup ?? "adult"}>
          <option value="adult">{labels.adult}</option>
          <option value="child">{labels.child}</option>
          <option value="infant">{labels.infant}</option>
        </Select>
      </Field>
      <Field label={labels.diet} htmlFor={id("diet")}>
        <Select id={id("diet")} name={name("diet")} defaultValue={guest?.diet ?? ""}>
          <option value="">{labels.dietNotSet}</option>
          {(["veg", "non_veg", "jain", "vegan", "other"] as const).map((d) => (
            <option key={d} value={d}>
              {labels[d]}
            </option>
          ))}
        </Select>
      </Field>
      {!compact && (
        <>
          <Field label={labels.dietNotes} htmlFor={id("dietNotes")}>
            <Input id={id("dietNotes")} name={name("dietNotes")} maxLength={200} defaultValue={guest?.dietNotes ?? ""} />
          </Field>
          <Field label={labels.accessibility} htmlFor={id("accessibilityNotes")}>
            <Input id={id("accessibilityNotes")} name={name("accessibilityNotes")} maxLength={500} defaultValue={guest?.accessibilityNotes ?? ""} />
          </Field>
        </>
      )}
      <div className="sm:col-span-2">
        <Field label={labels.tags} htmlFor={id("tags")} hint={labels.tagsHelp}>
          <Input id={id("tags")} name={name("tags")} maxLength={300} defaultValue={guest?.tags?.join(", ") ?? ""} />
        </Field>
      </div>
    </div>
  );
}
