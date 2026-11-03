"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type EventTab = { href: string; label: string; badge?: number };

/** The first tab (dashboard) matches exactly; the others match their sub-pages too. */
export const isActiveTab = (pathname: string, href: string, index: number) =>
  index === 0 ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

/** Event sections as a tab strip, from `sm` up; phones get the burger menu (`EventMenu`). */
export function EventTabs({ tabs, label }: { tabs: EventTab[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mx-4 mb-6 hidden overflow-x-auto border-b border-border px-4 sm:block">
      <ul className="flex gap-1 whitespace-nowrap">
        {tabs.map((tab, i) => {
          const active = isActiveTab(pathname, tab.href, i);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm ${
                  active ? "border-brand font-medium text-text" : "border-transparent text-muted hover:text-text"
                }`}
              >
                {tab.label}
                {!!tab.badge && (
                  <span className="rounded-full bg-warning-soft px-1.5 text-xs font-medium text-warning">{tab.badge}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
