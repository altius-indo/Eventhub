"use client";

import { useOptimistic, useState, useTransition } from "react";

type Status = "attending" | "maybe" | "declined";
type Result = { error?: string; info?: string };
type Action = (formData: FormData) => Promise<Result>;

const pressed: Record<Status, string> = {
  attending: "border-success bg-success-soft text-success",
  maybe: "border-warning bg-warning-soft text-warning",
  declined: "border-danger bg-danger-soft text-danger",
};
const base = "flex min-h-11 items-center justify-center rounded-lg border px-1 text-center text-xs leading-tight font-medium sm:text-sm";
const idle = "border-border bg-surface text-text hover:bg-surface-muted";

/**
 * One member's reply on the RSVP desk (RSV-04): four buttons, one tap saves. The choice shows
 * at once (optimistic) and settles to the server's answer when the page refreshes.
 */
export function RsvpSegment({
  action,
  guestId,
  status,
  label,
  labels,
}: {
  action: Action;
  guestId: string;
  status: Status | null;
  /** Accessible group name, e.g. "Reply for Rajesh". */
  label: string;
  labels: Record<Status | "clear", string>;
}) {
  const [shown, setShown] = useOptimistic(status);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const pick = (next: Status | null) =>
    start(async () => {
      setShown(next);
      const fd = new FormData();
      fd.set("guestId", guestId);
      fd.set("status", next ?? "clear");
      const res = await action(fd);
      setError(res?.error ?? null);
    });

  return (
    <div>
      <div role="group" aria-label={label} aria-busy={pending} className="grid grid-cols-4 gap-1">
        {(["attending", "maybe", "declined"] as const).map((s) => (
          <button key={s} type="button" aria-pressed={shown === s} onClick={() => pick(s)} className={`${base} ${shown === s ? pressed[s] : idle}`}>
            {labels[s]}
          </button>
        ))}
        <button type="button" onClick={() => pick(null)} disabled={shown === null} className={`${base} ${idle} text-muted disabled:opacity-50`}>
          {labels.clear}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** "Whole family attending / not attending" for one function. */
export function FamilyRsvpButtons({ action, householdId, labels }: { action: Action; householdId: string; labels: { attending: string; declined: string } }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const pick = (status: "attending" | "declined") =>
    start(async () => {
      const fd = new FormData();
      fd.set("householdId", householdId);
      fd.set("status", status);
      const res = await action(fd);
      setError(res?.error ?? null);
    });
  return (
    <div aria-busy={pending}>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={() => pick("attending")} className={`${base} ${idle} px-3 disabled:opacity-60`}>
          {labels.attending}
        </button>
        <button type="button" disabled={pending} onClick={() => pick("declined")} className={`${base} ${idle} px-3 disabled:opacity-60`}>
          {labels.declined}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
