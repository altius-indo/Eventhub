"use client";

import { useState } from "react";
import { buttonClass } from "./ui";

export function CopyButton({ text, label, copiedLabel, variant = "secondary" }: { text: string; label: string; copiedLabel: string; variant?: "primary" | "secondary" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={buttonClass(variant)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          window.prompt("", text);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}
