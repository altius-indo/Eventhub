import type { GuestTravel } from "@/db/schema";
import { toLocalInput } from "@/lib/travel";
import { Field, Input, Select } from "./ui";

export type TravelLabels = Record<
  "arrival" | "departure" | "mode" | "number" | "when" | "point" | "needsPickup" | "needsDrop" | "notes" | "flight" | "train" | "bus" | "car" | "other" | "none",
  string
>;

export function TravelFields({ labels, travel, idBase = "" }: { labels: TravelLabels; travel?: GuestTravel | null; idBase?: string }) {
  const id = (k: string) => `${idBase}${k}`;
  const leg = (kind: "arrival" | "departure") => (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium">{labels[kind]}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={labels.mode} htmlFor={id(`${kind}Mode`)}>
          <Select id={id(`${kind}Mode`)} name={`${kind}Mode`} defaultValue={travel?.[`${kind}Mode`] ?? ""}>
            <option value="">{labels.none}</option>
            {(["flight", "train", "bus", "car", "other"] as const).map((m) => (
              <option key={m} value={m}>
                {labels[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.number} htmlFor={id(`${kind}Number`)}>
          <Input id={id(`${kind}Number`)} name={`${kind}Number`} maxLength={40} defaultValue={travel?.[`${kind}Number`] ?? ""} />
        </Field>
        <Field label={labels.when} htmlFor={id(`${kind}At`)}>
          <Input id={id(`${kind}At`)} name={`${kind}At`} type="datetime-local" defaultValue={toLocalInput(travel?.[`${kind}At`])} />
        </Field>
        <Field label={labels.point} htmlFor={id(`${kind}Point`)}>
          <Input id={id(`${kind}Point`)} name={`${kind}Point`} maxLength={120} defaultValue={travel?.[`${kind}Point`] ?? ""} />
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name={kind === "arrival" ? "needsPickup" : "needsDrop"}
          defaultChecked={kind === "arrival" ? travel?.needsPickup : travel?.needsDrop}
          className="h-5 w-5"
        />
        {kind === "arrival" ? labels.needsPickup : labels.needsDrop}
      </label>
    </fieldset>
  );
  return (
    <div className="space-y-3">
      {leg("arrival")}
      {leg("departure")}
      <Field label={labels.notes} htmlFor={id("notes")}>
        <Input id={id("notes")} name="notes" maxLength={500} defaultValue={travel?.notes ?? ""} />
      </Field>
    </div>
  );
}
