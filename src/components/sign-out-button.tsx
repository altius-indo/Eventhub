"use client";

import { signOutAction } from "@/app/actions";

/** Signs out, drops cached pages and any unsent check-ins on this device (shared devices). */
export function SignOutButton({ label }: { label: string }) {
  return (
    <form
      action={signOutAction}
      onSubmit={() => {
        navigator.serviceWorker?.controller?.postMessage("clear-pages");
        try {
          for (const key of Object.keys(localStorage)) if (key.startsWith("eh_checkin_queue_")) localStorage.removeItem(key);
        } catch {
          /* storage unavailable */
        }
      }}
    >
      <button type="submit" className="min-h-9 rounded-md px-2 text-sm text-muted hover:bg-surface-muted hover:text-text">
        {label}
      </button>
    </form>
  );
}
