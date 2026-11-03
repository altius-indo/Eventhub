import "server-only";
import type { HouseholdFieldLabels } from "@/components/household-fields";
import type { Translator } from "@/i18n/core";

export function householdFieldLabels(t: Translator): HouseholdFieldLabels {
  return {
    name: t("household.name"),
    namePlaceholder: t("household.namePlaceholder"),
    side: t("household.side"),
    bride: t("sides.bride"),
    groom: t("sides.groom"),
    both: t("sides.both"),
    address: t("household.address"),
    city: t("household.city"),
    postalCode: t("household.postalCode"),
    notes: t("household.notes"),
  };
}
