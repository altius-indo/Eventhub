import "server-only";
import type { TravelLabels } from "@/components/travel-fields";
import { formatWallClock, type Locale, type Translator } from "@/i18n/core";
import type { GuestTravel } from "@/db/schema";

export function travelLabels(t: Translator): TravelLabels {
  return {
    arrival: t("travel.arrival"),
    departure: t("travel.departure"),
    mode: t("travel.mode"),
    number: t("travel.number"),
    when: t("travel.when"),
    point: t("travel.point"),
    needsPickup: t("travel.needsPickup"),
    needsDrop: t("travel.needsDrop"),
    notes: t("travel.notes"),
    flight: t("travel.modes.flight"),
    train: t("travel.modes.train"),
    bus: t("travel.modes.bus"),
    car: t("travel.modes.car"),
    other: t("travel.modes.other"),
    none: "—",
  };
}

export { formatWallClock } from "@/i18n/core";

export function travelSummary(t: Translator, locale: Locale, travel: GuestTravel): string {
  const leg = (mode: GuestTravel["arrivalMode"], num: string | null, at: Date | null, point: string | null) =>
    [mode && t(`travel.modes.${mode}`), num, at && formatWallClock(locale, at), point].filter(Boolean).join(" ") || "—";
  return t("travel.summary", {
    arrival: leg(travel.arrivalMode, travel.arrivalNumber, travel.arrivalAt, travel.arrivalPoint),
    departure: leg(travel.departureMode, travel.departureNumber, travel.departureAt, travel.departurePoint),
  });
}
