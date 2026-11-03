"use client";

import { useContext, type ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { PendingContext } from "./pending-context";
import { buttonClass } from "./ui";

type Props = ComponentProps<"button"> & { variant?: "primary" | "secondary" | "danger" | "ghost" };

export function SubmitButton({ variant = "primary", className, children, disabled, ...props }: Props) {
  const status = useFormStatus();
  const contextPending = useContext(PendingContext);
  const pending = status.pending || contextPending;
  return (
    <button type="submit" className={buttonClass(variant, className)} disabled={pending || disabled} aria-busy={pending} {...props}>
      {children}
    </button>
  );
}
