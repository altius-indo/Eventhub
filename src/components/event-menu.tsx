"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { isActiveTab, type EventTab } from "./event-tabs";
import { moveFocus, usePopover } from "./use-popover";

/** Gear icon at the right of the event toolbar; event Settings moved here from the tab strip. */
export function EventSettingsLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-muted hover:text-text ${
        active ? "bg-primary-soft text-primary" : "text-muted"
      }`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </Link>
  );
}

/**
 * Phones (below `sm`): a burger button in the event toolbar that opens the event's sections
 * (the same list as the tab strip, current one marked, badges kept).
 */
export function EventMenu({ tabs, label, buttonLabel }: { tabs: EventTab[]; label: string; buttonLabel: string }) {
  const pathname = usePathname();
  const { open, toggle, close, buttonRef, panelRef } = usePopover();
  const panelId = useId();
  const badgeTotal = tabs.reduce((a, t) => a + (t.badge ?? 0), 0);
  return (
    <div className="relative sm:hidden">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={buttonLabel}
        title={buttonLabel}
        className="relative inline-flex size-11 items-center justify-center rounded-lg border border-border bg-surface text-text hover:bg-surface-muted"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
        {!open && badgeTotal > 0 && <span aria-hidden="true" className="absolute right-1 top-1 size-2.5 rounded-full bg-warning" />}
      </button>
      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        className="absolute left-0 top-full z-30 mt-2 max-h-[70dvh] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg"
      >
        <nav aria-label={label} onKeyDown={moveFocus}>
          <ul>
            {tabs.map((tab, i) => {
              const active = isActiveTab(pathname, tab.href, i);
              return (
                <li key={tab.href}>
                  <Link
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => close(false)}
                    className={`flex min-h-11 items-center justify-between gap-2 rounded-lg px-3 text-sm ${
                      active ? "bg-primary-soft font-medium text-primary" : "text-text hover:bg-surface-muted"
                    }`}
                  >
                    <span>{tab.label}</span>
                    {!!tab.badge && <span className="rounded-full bg-warning-soft px-1.5 text-xs font-medium text-warning">{tab.badge}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}
