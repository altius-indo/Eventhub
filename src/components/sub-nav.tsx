"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The link for the current page: the longest href that is the path or a parent of it. */
export function activeHref(pathname: string, hrefs: string[]) {
  let best: string | null = null;
  for (const h of hrefs) {
    const path = h.split("?")[0];
    if ((pathname === path || pathname.startsWith(`${path}/`)) && (!best || path.length > best.split("?")[0].length)) best = h;
  }
  return best;
}

/** Pill links for a section's pages (Services, Vendors, Budget, Logistics, Gallery, …). */
export function SubNav({ label, links }: { label: string; links: { href: string; label: string }[] }) {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname, links.map((l) => l.href));
  return (
    <nav aria-label={label} className="mb-5 flex flex-wrap gap-2 text-sm print:hidden">
      {links.map((l) => {
        const current = l.href === active;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={current ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-full border px-4 ${
              current ? "border-primary bg-primary font-medium text-primary-contrast" : "border-border bg-surface hover:bg-surface-muted"
            }`}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
