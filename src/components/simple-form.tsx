"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { PendingContext } from "./pending-context";
import { Alert } from "./ui";

type State = { error?: string; info?: string };

/**
 * A form bound to a server action that returns {error?, info?}. Unlike a plain
 * `<form action>`, fields keep what the user typed when the action returns an
 * error, and are reset after a success.
 */
export function SimpleForm({
  action,
  children,
  className = "space-y-4",
  id,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  children: ReactNode;
  className?: string;
  /** Lets fields elsewhere on the page join this form via their `form` attribute. */
  id?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.info && !state.error) ref.current?.reset();
  }, [state]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const formData = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(formData));
  }

  return (
    <PendingContext value={pending}>
      <form ref={ref} id={id} onSubmit={onSubmit} className={className}>
        {children}
        {state.error && <Alert tone="danger">{state.error}</Alert>}
        {state.info && <Alert tone="success">{state.info}</Alert>}
      </form>
    </PendingContext>
  );
}
