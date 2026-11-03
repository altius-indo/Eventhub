"use client";

import type { ComponentProps } from "react";
import { SubmitButton } from "./submit-button";

/** A submit button that asks for confirmation first (for destructive actions). */
export function ConfirmButton({ confirm, onClick, ...props }: ComponentProps<typeof SubmitButton> & { confirm: string }) {
  return (
    <SubmitButton
      {...props}
      onClick={(e) => {
        if (!window.confirm(confirm)) e.preventDefault();
        onClick?.(e);
      }}
    />
  );
}
