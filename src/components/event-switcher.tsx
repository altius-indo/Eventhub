"use client";

import Link from "next/link";
import { useId } from "react";
import { EventAvatar } from "./event-avatar";
import { moveFocus, usePopover } from "./use-popover";

export type SwitcherEvent = { id: string; name: string; logoUrl: string | null; roleLabel: string | null; host: boolean };

/**
 * Event switcher in the event toolbar (EVT-03): the current event (logo + name) opens a list of
 * the user's other events, plus "All events" and "Create event".
 */
export function EventSwitcher({
  current,
  others,
  labels,
}: {
  current: SwitcherEvent;
  others: SwitcherEvent[];
  labels: { switch: string; yourEvents: string; allEvents: string; createEvent: string; current: string };
}) {
  const { open, toggle, close, buttonRef, panelRef } = usePopover();
  const panelId = useId();
  const row = "flex min-h-11 items-center gap-3 rounded-lg px-3 py-1.5 text-sm";
  return (
    <div className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="true"
        title={labels.switch}
        className="flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg py-0.5 pl-0.5 pr-1.5 text-left hover:bg-surface-muted"
      >
        <EventAvatar name={current.name} logoUrl={current.logoUrl} />
        <span className="min-w-0 truncate">{current.name}</span>
        <span className="sr-only">{labels.switch}</span>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        className="absolute left-0 top-full z-30 mt-2 max-h-[70dvh] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-1 text-base font-normal shadow-lg"
      >
        <nav aria-label={labels.yourEvents} onKeyDown={moveFocus}>
          <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted">{labels.yourEvents}</p>
          <ul>
            {[current, ...others].map((e) => {
              const isCurrent = e.id === current.id;
              return (
                <li key={e.id}>
                  <Link
                    href={`/events/${e.id}`}
                    aria-current={isCurrent ? "page" : undefined}
                    onClick={() => close(false)}
                    className={`${row} ${isCurrent ? "bg-primary-soft" : "hover:bg-surface-muted"}`}
                  >
                    <EventAvatar name={e.name} logoUrl={e.logoUrl} size="sm" />
                    <span className="min-w-0 flex-1 truncate font-medium">{e.name}</span>
                    {isCurrent && <span className="sr-only">{labels.current}</span>}
                    {e.roleLabel && (
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${e.host ? "bg-primary-soft text-primary" : "bg-surface-muted text-muted"}`}>
                        {e.roleLabel}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 border-t border-border pt-1">
            <Link href="/events" onClick={() => close(false)} className={`${row} hover:bg-surface-muted`}>
              {labels.allEvents}
            </Link>
            <Link href="/events/new" onClick={() => close(false)} className={`${row} text-primary hover:bg-surface-muted`}>
              <span aria-hidden="true">+</span> {labels.createEvent}
            </Link>
          </div>
        </nav>
      </div>
    </div>
  );
}
