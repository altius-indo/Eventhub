import type { TransferRun } from "@/db/schema";
import { toWallClockInput } from "@/lib/wall-clock";
import { Field, Input, Select, Textarea } from "./ui";

export type RunFieldLabels = Record<
  "kind" | "pickup" | "drop" | "shuttle" | "departsAt" | "from" | "to" | "vehicle" | "vehiclePlaceholder" | "driverName" | "driverPhone" | "capacity" | "notes" | "function" | "none",
  string
>;

export function RunFields({
  labels,
  run,
  functions,
}: {
  labels: RunFieldLabels;
  run?: Partial<TransferRun>;
  functions: { id: string; name: string }[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={labels.kind} htmlFor="kind">
        <Select id="kind" name="kind" defaultValue={run?.kind ?? "pickup"}>
          <option value="pickup">{labels.pickup}</option>
          <option value="drop">{labels.drop}</option>
          <option value="shuttle">{labels.shuttle}</option>
        </Select>
      </Field>
      <Field label={labels.departsAt} htmlFor="departsAt">
        <Input id="departsAt" name="departsAt" type="datetime-local" required defaultValue={toWallClockInput(run?.departsAt)} />
      </Field>
      <Field label={labels.from} htmlFor="fromPlace">
        <Input id="fromPlace" name="fromPlace" required maxLength={160} defaultValue={run?.fromPlace ?? ""} />
      </Field>
      <Field label={labels.to} htmlFor="toPlace">
        <Input id="toPlace" name="toPlace" required maxLength={160} defaultValue={run?.toPlace ?? ""} />
      </Field>
      <Field label={labels.vehicle} htmlFor="vehicle">
        <Input id="vehicle" name="vehicle" maxLength={80} placeholder={labels.vehiclePlaceholder} defaultValue={run?.vehicle ?? ""} />
      </Field>
      <Field label={labels.capacity} htmlFor="capacity">
        <Input id="capacity" name="capacity" type="number" min={1} max={100} required defaultValue={run?.capacity ?? 4} />
      </Field>
      <Field label={labels.driverName} htmlFor="driverName">
        <Input id="driverName" name="driverName" maxLength={80} defaultValue={run?.driverName ?? ""} />
      </Field>
      <Field label={labels.driverPhone} htmlFor="driverPhone">
        <Input id="driverPhone" name="driverPhone" type="tel" maxLength={30} defaultValue={run?.driverPhone ?? ""} />
      </Field>
      <Field label={labels.function} htmlFor="functionId">
        <Select id="functionId" name="functionId" defaultValue={run?.functionId ?? ""}>
          <option value="">{labels.none}</option>
          {functions.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={labels.notes} htmlFor="notes">
        <Textarea id="notes" name="notes" rows={2} maxLength={500} defaultValue={run?.notes ?? ""} />
      </Field>
    </div>
  );
}
