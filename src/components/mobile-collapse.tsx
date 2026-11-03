"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * On phones, folds a block (search and filters) behind one button so the list starts higher
 * up; the button shows how many filters are on. From the `sm` breakpoint up it's always open.
 * Open/closed survives filter changes on the same page (the component keeps its state).
 */
export function MobileCollapse({
  label,
  activeLabel,
  activeCount,
  children,
}: {
  label: string;
  /** Shown when filters are on, with {count}. */
  activeLabel: string;
  activeCount: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg text-left text-sm font-medium sm:hidden"
      >
        <span className="flex items-center gap-2">
          <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.5 13.5L17 17" strokeLinecap="round" />
          </svg>
          {activeCount > 0 ? (
            <span>
              {activeLabel.replace("{count}", String(activeCount))}
            </span>
          ) : (
            label
          )}
        </span>
        <svg aria-hidden viewBox="0 0 20 20" className={`h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div id={id} className={`${open ? "mt-3 block" : "hidden"} sm:mt-0 sm:block`}>
        {children}
      </div>
    </div>
  );
}
