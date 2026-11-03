"use client";

import { buttonClass } from "./ui";

export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={buttonClass("primary", "print:hidden")}>
      {label}
    </button>
  );
}
