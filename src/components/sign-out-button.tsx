"use client";

import { signOutAction } from "@/app/actions";
import { clearOfflineCopies, QUEUE_PREFIX } from "./offline-pages";

/** Signs out, drops cached pages, any unsent check-ins and the offline guest list on this device (shared devices). */
export function SignOutButton({ label, unsavedWarning }: { label: string; unsavedWarning: string }) {
  return (
    <form
      action={signOutAction}
      onSubmit={(e) => {
        let unsaved = false;
        try {
          unsaved = Object.keys(localStorage).some((k) => k.startsWith(QUEUE_PREFIX) && localStorage.getItem(k) !== "[]");
        } catch {
          /* storage unavailable */
        }
        if (unsaved && !window.confirm(unsavedWarning)) {
          e.preventDefault();
          return;
        }
        // Queued check-ins and the offline guest-list copy (ADR-0034) never outlive the session.
        clearOfflineCopies({ queues: true });
      }}
    >
      <button type="submit" className="min-h-9 rounded-md px-2 text-sm text-muted hover:bg-surface-muted hover:text-text">
        {label}
      </button>
    </form>
  );
}
