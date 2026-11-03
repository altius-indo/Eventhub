"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import { GuestFields, type GuestFieldLabels } from "./guest-fields";
import { HouseholdFields, type HouseholdFieldLabels } from "./household-fields";
import { PendingContext } from "./pending-context";
import { SubmitButton } from "./submit-button";
import { Alert, Button, Card, CardTitle } from "./ui";

type State = { error?: string };

export function HouseholdCreateForm({
  action,
  householdLabels,
  guestLabels,
  functions,
  labels,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  householdLabels: HouseholdFieldLabels;
  guestLabels: GuestFieldLabels;
  functions: { id: string; name: string }[];
  labels: { details: string; members: string; addMember: string; remove: string; inviteAll: string; submit: string; head: string };
}) {
  const [state, formAction, pending] = useActionState(action, {});
  // Stable keys so removing a middle member keeps the others' typed values
  const [keys, setKeys] = useState<number[]>([0]);
  const [nextKey, setNextKey] = useState(1);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("memberKeys", keys.join(","));
    startTransition(() => formAction(fd));
  }

  return (
    <PendingContext value={pending}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardTitle>{labels.details}</CardTitle>
          <HouseholdFields labels={householdLabels} />
        </Card>
        <Card>
          <CardTitle>{labels.members}</CardTitle>
          <ol className="space-y-5">
            {keys.map((key, i) => (
              <li key={key} className="space-y-2 border-b border-border pb-5 last:border-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted">
                    {i + 1}. {i === 0 && labels.head}
                  </span>
                  {keys.length > 1 && (
                    <Button type="button" variant="ghost" className="min-h-9 text-danger" onClick={() => setKeys(keys.filter((k) => k !== key))}>
                      {labels.remove}
                    </Button>
                  )}
                </div>
                <GuestFields labels={guestLabels} prefix={`m${key}_`} compact />
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="secondary"
            className="mt-4"
            onClick={() => {
              setKeys([...keys, nextKey]);
              setNextKey(nextKey + 1);
            }}
          >
            + {labels.addMember}
          </Button>
        </Card>
        {functions.length > 0 && (
          <Card>
            <CardTitle>{labels.inviteAll}</CardTitle>
            <div className="flex flex-wrap gap-2">
              {functions.map((fn) => (
                <label key={fn.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm">
                  <input type="checkbox" name="functionIds" value={fn.id} defaultChecked /> {fn.name}
                </label>
              ))}
            </div>
          </Card>
        )}
        {state.error && <Alert tone="danger">{state.error}</Alert>}
        <SubmitButton>{labels.submit}</SubmitButton>
      </form>
    </PendingContext>
  );
}
