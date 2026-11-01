import type { RunSheetItem } from "@/db/schema";
import { toWallClockInput } from "@/lib/wall-clock";
import { Field, Input, Select, Textarea } from "./ui";

export type RunItemLabels = Record<"startsAt" | "duration" | "itemTitle" | "ownerTeam" | "ownerName" | "ownerPhone" | "location" | "notes" | "timeLocked" | "none", string>;

export function RunItemFields({
  labels,
  item,
  members,
  idBase = "",
  defaultStart,
  vendors = [],
  vendorLabel,
}: {
  labels: RunItemLabels;
  item?: RunSheetItem;
  members: { id: string; name: string | null }[];
  idBase?: string;
  defaultStart?: string;
  /** Vendors from the directory who can own an item (shown in their portal, VND-10). */
  vendors?: { id: string; name: string }[];
  vendorLabel?: string;
}) {
  const id = (k: string) => `${idBase}${k}`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={labels.itemTitle} htmlFor={id("title")}>
        <Input id={id("title")} name="title" required maxLength={200} defaultValue={item?.title ?? ""} />
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
        <Field label={labels.startsAt} htmlFor={id("startsAt")}>
          <Input id={id("startsAt")} name="startsAt" type="datetime-local" required defaultValue={item ? toWallClockInput(item.startsAt) : (defaultStart ?? "")} />
        </Field>
        <Field label={labels.duration} htmlFor={id("durationMin")}>
          <Input id={id("durationMin")} name="durationMin" type="number" min={1} max={1440} defaultValue={item?.durationMin ?? ""} />
        </Field>
      </div>
      <Field label={labels.ownerTeam} htmlFor={id("ownerUserId")}>
        <Select id={id("ownerUserId")} name="ownerUserId" defaultValue={item?.ownerUserId ?? ""}>
          <option value="">{labels.none}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      {vendorLabel && (
        <Field label={vendorLabel} htmlFor={id("ownerVendorId")}>
          <Select id={id("ownerVendorId")} name="ownerVendorId" defaultValue={item?.ownerVendorId ?? ""}>
            <option value="">{labels.none}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={labels.location} htmlFor={id("location")}>
        <Input id={id("location")} name="location" maxLength={160} defaultValue={item?.location ?? ""} />
      </Field>
      <Field label={labels.ownerName} htmlFor={id("ownerName")}>
        <Input id={id("ownerName")} name="ownerName" maxLength={120} defaultValue={item?.ownerName ?? ""} />
      </Field>
      <Field label={labels.ownerPhone} htmlFor={id("ownerPhone")}>
        <Input id={id("ownerPhone")} name="ownerPhone" type="tel" maxLength={30} defaultValue={item?.ownerPhone ?? ""} />
      </Field>
      <div className="sm:col-span-2">
        <Field label={labels.notes} htmlFor={id("notes")}>
          <Textarea id={id("notes")} name="notes" rows={2} maxLength={2000} defaultValue={item?.notes ?? ""} />
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="timeLocked" defaultChecked={item?.timeLocked} className="h-5 w-5" /> {labels.timeLocked}
      </label>
    </div>
  );
}
