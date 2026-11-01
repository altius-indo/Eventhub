import type { Hotel, RoomBlock } from "@/db/schema";
import { Field, Input, Textarea } from "./ui";

export type HotelLabels = Record<"name" | "address" | "phone" | "mapUrl" | "notes", string>;
export type BlockLabels = Record<"roomType" | "roomTypePlaceholder" | "maxOccupancy" | "blockedCount" | "rate" | "rateHelp" | "checkIn" | "checkOut", string>;

export function HotelFields({ labels, hotel }: { labels: HotelLabels; hotel?: Partial<Hotel> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={labels.name} htmlFor="name">
        <Input id="name" name="name" required maxLength={160} defaultValue={hotel?.name ?? ""} />
      </Field>
      <Field label={labels.phone} htmlFor="phone">
        <Input id="phone" name="phone" type="tel" maxLength={30} defaultValue={hotel?.phone ?? ""} />
      </Field>
      <Field label={labels.address} htmlFor="address">
        <Textarea id="address" name="address" rows={2} maxLength={400} defaultValue={hotel?.address ?? ""} />
      </Field>
      <Field label={labels.mapUrl} htmlFor="mapUrl">
        <Input id="mapUrl" name="mapUrl" type="url" maxLength={500} defaultValue={hotel?.mapUrl ?? ""} />
      </Field>
    </div>
  );
}

export function BlockFields({ labels, block, idBase = "" }: { labels: BlockLabels; block?: Partial<RoomBlock>; idBase?: string }) {
  const id = (k: string) => `${idBase}${k}`;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label={labels.roomType} htmlFor={id("roomType")}>
        <Input id={id("roomType")} name="roomType" required maxLength={80} placeholder={labels.roomTypePlaceholder} defaultValue={block?.roomType ?? ""} />
      </Field>
      <Field label={labels.blockedCount} htmlFor={id("blockedCount")}>
        <Input id={id("blockedCount")} name="blockedCount" type="number" min={0} max={500} required defaultValue={block?.blockedCount ?? 5} />
      </Field>
      <Field label={labels.maxOccupancy} htmlFor={id("maxOccupancy")}>
        <Input id={id("maxOccupancy")} name="maxOccupancy" type="number" min={1} max={12} required defaultValue={block?.maxOccupancy ?? 2} />
      </Field>
      <Field label={labels.checkIn} htmlFor={id("checkIn")}>
        <Input id={id("checkIn")} name="checkIn" type="date" required defaultValue={block?.checkIn ?? ""} />
      </Field>
      <Field label={labels.checkOut} htmlFor={id("checkOut")}>
        <Input id={id("checkOut")} name="checkOut" type="date" required defaultValue={block?.checkOut ?? ""} />
      </Field>
      <Field label={labels.rate} htmlFor={id("rate")} hint={labels.rateHelp}>
        <Input id={id("rate")} name="rate" inputMode="decimal" defaultValue={block?.ratePaise != null ? String(block.ratePaise / 100) : ""} />
      </Field>
    </div>
  );
}
