"use client";

import { signOutAction } from "@/app/actions";

/** Signs out and asks the service worker to drop cached pages (shared devices). */
export function SignOutButton({ label }: { label: string }) {
  return (
    <form
      action={signOutAction}
      onSubmit={() => {
        navigator.serviceWorker?.controller?.postMessage("clear-pages");
      }}
    >
      <button type="submit" className="min-h-9 rounded-md px-2 text-sm text-muted hover:bg-surface-muted hover:text-text">
        {label}
      </button>
    </form>
  );
}
