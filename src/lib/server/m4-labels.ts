import "server-only";
import type { BlockLabels, HotelLabels } from "@/components/hotel-fields";
import type { RunFieldLabels } from "@/components/run-fields";
import type { RunItemLabels } from "@/components/run-item-fields";
import type { Translator } from "@/i18n/core";

export function runFieldLabels(t: Translator): RunFieldLabels {
  return {
    kind: t("transfers.kind"),
    pickup: t("transfers.kinds.pickup"),
    drop: t("transfers.kinds.drop"),
    shuttle: t("transfers.kinds.shuttle"),
    departsAt: t("transfers.departsAt"),
    from: t("transfers.from"),
    to: t("transfers.to"),
    vehicle: t("transfers.vehicle"),
    vehiclePlaceholder: t("transfers.vehiclePlaceholder"),
    driverName: t("transfers.driverName"),
    driverPhone: t("transfers.driverPhone"),
    capacity: t("transfers.capacity"),
    notes: t("transfers.notes"),
    function: t("transfers.function"),
    none: t("transfers.none"),
  };
}

export function hotelLabels(t: Translator): HotelLabels {
  return { name: t("hotels.name"), address: t("hotels.address"), phone: t("hotels.phone"), mapUrl: t("hotels.mapUrl"), notes: t("hotels.notes") };
}

export function blockLabels(t: Translator): BlockLabels {
  return {
    roomType: t("hotels.roomType"),
    roomTypePlaceholder: t("hotels.roomTypePlaceholder"),
    maxOccupancy: t("hotels.maxOccupancy"),
    blockedCount: t("hotels.blockedCount"),
    rate: t("hotels.rate"),
    rateHelp: t("hotels.rateHelp"),
    checkIn: t("hotels.checkIn"),
    checkOut: t("hotels.checkOut"),
  };
}

export function runItemLabels(t: Translator): RunItemLabels {
  return {
    startsAt: t("runsheet.startsAt"),
    duration: t("runsheet.duration"),
    itemTitle: t("runsheet.itemTitle"),
    ownerTeam: t("runsheet.ownerTeam"),
    ownerName: t("runsheet.ownerName"),
    ownerPhone: t("runsheet.ownerPhone"),
    location: t("runsheet.location"),
    notes: t("runsheet.notes"),
    timeLocked: t("runsheet.timeLocked"),
    none: t("transfers.none"),
  };
}
