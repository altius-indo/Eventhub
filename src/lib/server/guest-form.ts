import "server-only";
import type { GuestFieldLabels } from "@/components/guest-fields";
import type { Translator } from "@/i18n/core";
import { guestSchema, householdSchema, type GuestInput, type HouseholdInput } from "../guests";

const guestFieldNames = ["name", "relation", "ageGroup", "phone", "email", "diet", "dietNotes", "accessibilityNotes", "tags"] as const;

export function parseGuestFields(t: Translator, formData: FormData, prefix = ""): { ok: true; data: GuestInput } | { ok: false; error: string } {
  const raw = Object.fromEntries(guestFieldNames.map((f) => [f, String(formData.get(`${prefix}${f}`) ?? "")]));
  const parsed = guestSchema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  const key =
    issue.message === "phoneInvalid" ? "guestForm.phoneInvalid" : issue.message === "emailInvalid" ? "guestForm.emailInvalid" : "guestForm.nameRequired";
  const who = raw.name ? `${raw.name}: ` : "";
  return { ok: false, error: who + t(key) };
}

export function parseHouseholdFields(formData: FormData): HouseholdInput | null {
  const parsed = householdSchema.safeParse({
    name: String(formData.get("householdName") ?? ""),
    side: String(formData.get("side") ?? "both"),
    address: String(formData.get("address") ?? ""),
    city: String(formData.get("city") ?? ""),
    postalCode: String(formData.get("postalCode") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  });
  return parsed.success ? parsed.data : null;
}

export function guestFieldLabels(t: Translator): GuestFieldLabels {
  return {
    name: t("guestForm.name"),
    relation: t("guestForm.relation"),
    relationPlaceholder: t("guestForm.relationPlaceholder"),
    ageGroup: t("guestForm.ageGroup"),
    phone: t("guestForm.phone"),
    email: t("guestForm.email"),
    diet: t("guestForm.diet"),
    dietNotSet: t("guestForm.dietNotSet"),
    dietNotes: t("guestForm.dietNotes"),
    accessibility: t("guestForm.accessibility"),
    tags: t("guestForm.tags"),
    tagsHelp: t("guestForm.tagsHelp"),
    adult: t("ages.adult"),
    child: t("ages.child"),
    infant: t("ages.infant"),
    veg: t("diets.veg"),
    non_veg: t("diets.non_veg"),
    jain: t("diets.jain"),
    vegan: t("diets.vegan"),
    other: t("diets.other"),
  };
}
