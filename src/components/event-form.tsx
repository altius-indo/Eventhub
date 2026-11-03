"use client";

import { useActionState } from "react";
import type { Event } from "@/db/schema";
import { SubmitButton } from "./submit-button";
import { Alert, Field, Input } from "./ui";

type Values = { name?: string; coupleNames?: string | null; startDate?: string | null; endDate?: string | null; city?: string | null };

export type EventFormState = {
  error?: string;
  fieldErrors?: Partial<Record<"name" | "endDate", string>>;
  info?: string;
  /** Submitted values, echoed back so a failed submission doesn't clear the form. */
  values?: Values;
};

type Labels = {
  name: string;
  namePlaceholder: string;
  coupleNames: string;
  coupleNamesPlaceholder: string;
  startDate: string;
  endDate: string;
  city: string;
  cityPlaceholder: string;
  submit: string;
};

export function EventForm({
  action,
  labels,
  event,
  disabled,
}: {
  action: (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
  labels: Labels;
  event?: Pick<Event, "name" | "coupleNames" | "startDate" | "endDate" | "city">;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, {});
  const v: Values = state.values ?? event ?? {};
  return (
    <form action={formAction} className="space-y-4">
      <fieldset disabled={disabled} className="space-y-4">
        <Field label={labels.name} htmlFor="name" error={state.fieldErrors?.name}>
          <Input id="name" name="name" required maxLength={120} placeholder={labels.namePlaceholder} defaultValue={v.name ?? ""} />
        </Field>
        <Field label={labels.coupleNames} htmlFor="coupleNames">
          <Input id="coupleNames" name="coupleNames" maxLength={120} placeholder={labels.coupleNamesPlaceholder} defaultValue={v.coupleNames ?? ""} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={labels.startDate} htmlFor="startDate">
            <Input id="startDate" name="startDate" type="date" defaultValue={v.startDate ?? ""} />
          </Field>
          <Field label={labels.endDate} htmlFor="endDate" error={state.fieldErrors?.endDate}>
            <Input id="endDate" name="endDate" type="date" defaultValue={v.endDate ?? ""} />
          </Field>
        </div>
        <Field label={labels.city} htmlFor="city">
          <Input id="city" name="city" maxLength={80} placeholder={labels.cityPlaceholder} defaultValue={v.city ?? ""} />
        </Field>
      </fieldset>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.info && <Alert tone="success">{state.info}</Alert>}
      {!disabled && <SubmitButton>{labels.submit}</SubmitButton>}
    </form>
  );
}
