"use client";

import { useActionState } from "react";
import { SubmitButton } from "./submit-button";
import { Alert, Field, Input } from "./ui";

type State = { error?: string; info?: string };
type Action = (prev: State, formData: FormData) => Promise<State>;

/** Six-digit code entry with a "send a new code" button. Used for login, step-up and adding identifiers. */
export function CodeForm({
  verify,
  resend,
  labels,
}: {
  verify: Action;
  resend: Action;
  labels: { code: string; submit: string; resend: string };
}) {
  const [state, verifyAction] = useActionState(verify, {});
  const [resendState, resendAction] = useActionState(resend, {});
  return (
    <div className="space-y-3">
      <form action={verifyAction} className="space-y-4">
        <Field label={labels.code} htmlFor="code">
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            className="text-center font-mono text-2xl tracking-[0.4em]"
          />
        </Field>
        {state.error && <Alert tone="danger">{state.error}</Alert>}
        <SubmitButton className="w-full">{labels.submit}</SubmitButton>
      </form>
      <form action={resendAction}>
        {resendState.error && <Alert tone="danger">{resendState.error}</Alert>}
        {resendState.info && <Alert tone="success">{resendState.info}</Alert>}
        <SubmitButton variant="ghost" className="w-full">
          {labels.resend}
        </SubmitButton>
      </form>
    </div>
  );
}
