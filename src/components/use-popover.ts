"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Open/close state for a button + menu panel: closes on Escape (focus back to the button), on a
 * tap outside, and after navigation; focuses the first item (or the current one) on open.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const [openedAt, setOpenedAt] = useState(pathname);

  // Navigation (a link in the panel was followed): close. Adjusting state during render on a
  // prop change is React's recommended alternative to an effect here.
  if (open && openedAt !== pathname) {
    setOpen(false);
    setOpenedAt(pathname);
  }

  const close = useCallback((focusButton = false) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    setOpenedAt(pathname);
    setOpen((o) => !o);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>("[aria-current='page'], [aria-current='true']") ?? panel?.querySelector<HTMLElement>("a, button");
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  return { open, toggle, close, buttonRef, panelRef };
}

/** Arrow-key movement between the links/buttons of a menu panel. */
export function moveFocus(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
  if (items.length === 0) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[next]?.focus();
}
