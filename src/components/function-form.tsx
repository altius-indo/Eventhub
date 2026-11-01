"use client";

import { useActionState } from "react";
import type { EventFunction } from "@/db/schema";
import { SubmitButton } from "./submit-button";
import { Alert, Field, Input, Textarea } from "./ui";

type Values = Partial<Record<"name" | "date" | "startTime" | "endTime" | "venueName" | "venueAddress" | "mapUrl" | "dressCode" | "description", string | null>> & {
  isPublic?: boolean;
  venuePublic?: boolean;
};
export type FunctionFormState = { error?: string; info?: string; fieldErrors?: Partial<Record<keyof Values, string>>; values?: Values };

export type FunctionFormLabels = Record<
  | "name"
  | "namePlaceholder"
  | "date"
  | "startTime"
  | "endTime"
  | "venueName"
  | "venueAddress"
  | "mapUrl"
  | "dressCode"
  | "dressCodePlaceholder"
  | "description"
  | "isPublic"
  | "venuePublic"
  | "submit",
  string
>;

export function FunctionForm({
  action,
  labels,
  fn,
  defaultDate,
}: {
  action: (prev: FunctionFormState, formData: FormData) => Promise<FunctionFormState>;
  labels: FunctionFormLabels;
  fn?: EventFunction;
  defaultDate?: string | null;
}) {
  const [state, formAction] = useActionState(action, {});
  const v: Values = state.values ?? fn ?? { date: defaultDate ?? "" };
  const e = state.fieldErrors ?? {};
  const val = (k: Exclude<keyof Values, "isPublic" | "venuePublic">) => (v[k] ?? "").slice(0, k === "startTime" || k === "endTime" ? 5 : undefined);
  return (
    <form action={formAction} className="space-y-4">
      <Field label={labels.name} htmlFor="name" error={e.name}>
        <Input id="name" name="name" required maxLength={120} placeholder={labels.namePlaceholder} defaultValue={val("name")} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={labels.date} htmlFor="date">
          <Input id="date" name="date" type="date" defaultValue={val("date")} />
        </Field>
        <Field label={labels.startTime} htmlFor="startTime">
          <Input id="startTime" name="startTime" type="time" defaultValue={val("startTime")} />
        </Field>
        <Field label={labels.endTime} htmlFor="endTime" error={e.endTime}>
          <Input id="endTime" name="endTime" type="time" defaultValue={val("endTime")} />
        </Field>
      </div>
      <Field label={labels.venueName} htmlFor="venueName">
        <Input id="venueName" name="venueName" maxLength={160} defaultValue={val("venueName")} />
      </Field>
      <Field label={labels.venueAddress} htmlFor="venueAddress">
        <Textarea id="venueAddress" name="venueAddress" rows={2} maxLength={400} defaultValue={val("venueAddress")} />
      </Field>
      <Field label={labels.mapUrl} htmlFor="mapUrl" error={e.mapUrl}>
        <Input id="mapUrl" name="mapUrl" type="url" inputMode="url" placeholder="https://maps.google.com/…" defaultValue={val("mapUrl")} />
      </Field>
      <Field label={labels.dressCode} htmlFor="dressCode">
        <Input id="dressCode" name="dressCode" maxLength={200} placeholder={labels.dressCodePlaceholder} defaultValue={val("dressCode")} />
      </Field>
      <Field label={labels.description} htmlFor="description">
        <Textarea id="description" name="description" rows={3} maxLength={2000} defaultValue={val("description")} />
      </Field>
      <div className="space-y-1">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="isPublic" defaultChecked={!!v.isPublic} className="h-5 w-5" /> {labels.isPublic}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="venuePublic" defaultChecked={!!v.venuePublic} className="h-5 w-5" /> {labels.venuePublic}
        </label>
      </div>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.info && <Alert tone="success">{state.info}</Alert>}
      <SubmitButton>{labels.submit}</SubmitButton>
    </form>
  );
}
