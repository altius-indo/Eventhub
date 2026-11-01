"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function EventTabs({ tabs }: { tabs: { href: string; label: string; badge?: number }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Event" className="-mx-4 mb-6 overflow-x-auto border-b border-border px-4">
      <ul className="flex gap-1 whitespace-nowrap">
        {tabs.map((tab, i) => {
          const active = i === 0 ? pathname === tab.href : pathname.startsWith(tab.href);
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
