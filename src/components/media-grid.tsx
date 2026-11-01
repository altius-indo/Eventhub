import Link from "next/link";
import type { ReactNode } from "react";

export type GridItem = { id: string; href: string; /** A file URL (route handler), not a page. */ file?: boolean; thumb: string; video?: boolean; badge?: ReactNode; footer?: ReactNode; label: string };

const tile = "relative block overflow-hidden rounded-md bg-surface-muted focus-visible:ring-2 focus-visible:ring-primary";

function Thumb({ it }: { it: GridItem }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={it.thumb} alt="" loading="lazy" decoding="async" className="aspect-square w-full object-cover" />
      {it.video && (
        <span aria-hidden className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-xs text-white">
          ▶
        </span>
      )}
    </>
  );
}

/** A responsive grid of square thumbnails (lazy-loaded), each linking to the item. */
export function MediaGrid({ items, className = "" }: { items: GridItem[]; className?: string }) {
  return (
    <ul className={`grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-6 ${className}`}>
      {items.map((it) => (
        <li key={it.id} className="relative">
          {it.file ? (
            <a href={it.href} target="_blank" rel="noopener" className={tile} aria-label={it.label}>
              <Thumb it={it} />
            </a>
          ) : (
            <Link href={it.href} className={tile} aria-label={it.label}>
              <Thumb it={it} />
            </Link>
          )}
          {it.badge && <div className="pointer-events-none absolute right-1 top-1">{it.badge}</div>}
          {it.footer && <div className="mt-1">{it.footer}</div>}
        </li>
      ))}
    </ul>
  );
}
