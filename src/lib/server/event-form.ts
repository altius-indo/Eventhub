import "server-only";
import type { EventFormState } from "@/components/event-form";
import type { Translator } from "@/i18n/core";
import { eventDetailsSchema, type EventDetails } from "../events";

export function parseEventForm(t: Translator, formData: FormData): { ok: true; data: EventDetails } | { ok: false; state: EventFormState } {
  const values = {
    name: String(formData.get("name") ?? ""),
    coupleNames: String(formData.get("coupleNames") ?? ""),
    startDate: String(formData.get("startDate") ?? ""),
    endDate: String(formData.get("endDate") ?? ""),
    city: String(formData.get("city") ?? ""),
  };
  const parsed = eventDetailsSchema.safeParse(values);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors: EventFormState["fieldErrors"] = {};
  for (const issue of parsed.error.issues) {
    if (issue.path[0] === "name") fieldErrors.name = t("eventForm.nameRequired");
    if (issue.path[0] === "endDate") fieldErrors.endDate = t("eventForm.dateOrder");
  }
  return { ok: false, state: { fieldErrors, values } };
}

export function eventFormLabels(t: Translator, submit: string) {
  return {
    name: t("eventForm.name"),
    namePlaceholder: t("eventForm.namePlaceholder"),
    coupleNames: t("eventForm.coupleNames"),
    coupleNamesPlaceholder: t("eventForm.coupleNamesPlaceholder"),
    startDate: t("eventForm.startDate"),
    endDate: t("eventForm.endDate"),
    city: t("eventForm.city"),
    cityPlaceholder: t("eventForm.cityPlaceholder"),
    submit,
  };
}
