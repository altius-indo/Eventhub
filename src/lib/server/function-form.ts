import "server-only";
import type { FunctionFormLabels, FunctionFormState } from "@/components/function-form";
import type { Translator } from "@/i18n/core";
import { functionSchema, type FunctionInput } from "../functions";

const fields = ["name", "date", "startTime", "endTime", "venueName", "venueAddress", "mapUrl", "dressCode", "description"] as const;

export function parseFunctionForm(t: Translator, formData: FormData): { ok: true; data: FunctionInput } | { ok: false; state: FunctionFormState } {
  const values = Object.fromEntries(fields.map((f) => [f, String(formData.get(f) ?? "")]));
  const parsed = functionSchema.safeParse(values);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fieldErrors: FunctionFormState["fieldErrors"] = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path[0];
    if (path === "name") fieldErrors.name = t("functionForm.nameRequired");
    if (path === "endTime") fieldErrors.endTime = t("functionForm.timeOrder");
    if (path === "mapUrl") fieldErrors.mapUrl = t("functionForm.mapUrlInvalid");
  }
  return { ok: false, state: { fieldErrors, values } };
}

export function functionFormLabels(t: Translator, submit: string): FunctionFormLabels {
  return {
    name: t("functionForm.name"),
    namePlaceholder: t("functionForm.namePlaceholder"),
    date: t("functionForm.date"),
    startTime: t("functionForm.startTime"),
    endTime: t("functionForm.endTime"),
    venueName: t("functionForm.venueName"),
    venueAddress: t("functionForm.venueAddress"),
    mapUrl: t("functionForm.mapUrl"),
    dressCode: t("functionForm.dressCode"),
    dressCodePlaceholder: t("functionForm.dressCodePlaceholder"),
    description: t("functionForm.description"),
    submit,
  };
}
