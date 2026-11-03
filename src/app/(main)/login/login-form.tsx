"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Field, Input } from "@/components/ui";
import { requestLoginCodeAction, type FormState } from "./actions";

type Labels = {
  identifier: string;
  placeholder: string;
  channel: string;
  sms: string;
  whatsapp: string;
  submit: string;
};

export function LoginForm({ labels, next, phoneEnabled }: { labels: Labels; next: string; phoneEnabled: boolean }) {
  const [state, action] = useActionState<FormState, FormData>(requestLoginCodeAction, {});
  const [value, setValue] = useState("");
  const looksLikePhone = phoneEnabled && value.trim() !== "" && !value.includes("@") && /\d/.test(value);

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <Field label={labels.identifier} htmlFor="identifier">
        <Input
          id="identifier"
          name="identifier"
          autoComplete="username"
          inputMode="email"
          placeholder={labels.placeholder}
          required
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      {looksLikePhone && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">{labels.channel}</legend>
          <div className="flex gap-4 text-sm">
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="channel" value="sms" defaultChecked /> {labels.sms}
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="channel" value="whatsapp" /> {labels.whatsapp}
            </label>
          </div>
        </fieldset>
      )}
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <SubmitButton className="w-full">{labels.submit}</SubmitButton>
    </form>
  );
}
