import Link from "next/link";

/** Pill links for a section's pages (Services, Vendors, Budget, Logistics). */
export function SubNav({ label, links }: { label: string; links: { href: string; label: string }[] }) {
  return (
    <nav aria-label={label} className="mb-5 flex flex-wrap gap-2 text-sm print:hidden">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="inline-flex min-h-10 items-center rounded-full border border-border bg-surface px-4 hover:bg-surface-muted">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
