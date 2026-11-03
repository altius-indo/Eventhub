"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

type Values = Record<string, string>;
type Choice = { value: string; label: string };

export type FilterTabs = { name: string; label: string; options: Choice[] };
/** A one-tap filter: on when every key in `set` has that value; tapping toggles those keys. */
export type FilterChip = { label: string; set: Values };
export type FilterSelect = { name: string; label: string; options: Choice[] };

/** URL for a set of filter values: empty values are dropped, and paging restarts at page 1. */
function hrefFor(path: string, values: Values) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v && k !== "page") p.set(k, v);
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

const chipClass = (on: boolean) =>
  `inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${
    on ? "border-primary bg-primary text-white" : "border-border bg-surface text-text hover:bg-surface-muted"
  }`;

/**
 * Search-first filter bar for long lists (guests): the search applies as you type, tabs and
 * quick chips are plain links (work without JavaScript), and the rarer filters sit in a
 * "More filters" panel whose selects apply on change.
 */
export function ListFilterBar({
  values,
  search,
  tabs,
  chips,
  selects,
  labels,
}: {
  values: Values;
  search: { name: string; label: string; placeholder: string };
  tabs?: FilterTabs;
  chips: FilterChip[];
  selects: FilterSelect[];
  labels: { quick: string; more: string; moreActive: string; clear: string };
}) {
  const router = useRouter();
  const path = usePathname();
  const current = values[search.name] ?? "";
  const [q, setQ] = useState(current);
  const [seenQ, setSeenQ] = useState(current);
  const [sentQ, setSentQ] = useState(current);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow navigation (Clear, Back, saved views) but not our own search arriving mid-typing.
  if (current !== seenQ) {
    setSeenQ(current);
    if (current !== sentQ) setQ(current);
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const withQ = (next: Values) => ({ ...values, [search.name]: q.trim(), ...next });
  const go = (next: Values) => {
    const target = withQ(next);
    setSentQ(target[search.name] ?? "");
    startTransition(() => router.replace(hrefFor(path, target), { scroll: false }));
  };
  const onSearch = (text: string) => {
    setQ(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go({ [search.name]: text.trim() }), 300);
  };

  const chipOn = (c: FilterChip) => Object.entries(c.set).every(([k, v]) => values[k] === v);
  const chipHref = (c: FilterChip) => hrefFor(path, withQ(Object.fromEntries(Object.entries(c.set).map(([k, v]) => [k, chipOn(c) ? "" : v]))));
  const moreCount = selects.filter((s) => values[s.name]).length;
  const active = Object.entries(values).some(([k, v]) => v && k !== "page");

  return (
    <div className="space-y-3" aria-busy={pending}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (timer.current) clearTimeout(timer.current);
          go({ [search.name]: q.trim() });
        }}
      >
        <label htmlFor="list-q" className="sr-only">
          {search.label}
        </label>
        <input
          id="list-q"
          name={search.name}
          type="search"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={search.placeholder}
          autoComplete="off"
          className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
      </form>

      {tabs && (
        <nav aria-label={tabs.label} className="flex rounded-lg border border-border bg-surface-muted p-1">
          {tabs.options.map((o) => {
            const on = (values[tabs.name] ?? "") === o.value;
            return (
              <Link
                key={o.value || "all"}
                href={hrefFor(path, withQ({ [tabs.name]: o.value }))}
                replace
                scroll={false}
                aria-current={on ? "page" : undefined}
                className={`flex min-h-11 flex-1 items-center justify-center rounded-md px-1 text-sm font-medium ${
                  on ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-text"
                }`}
              >
                {o.label}
              </Link>
            );
          })}
        </nav>
      )}

      {chips.length > 0 && (
        <div role="group" aria-label={labels.quick} className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <Link key={c.label} href={chipHref(c)} replace scroll={false} aria-pressed={chipOn(c)} className={chipClass(chipOn(c))}>
              {c.label}
            </Link>
          ))}
        </div>
      )}

      {selects.length > 0 && (
        <details open={moreCount > 0} className="group rounded-lg border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            {moreCount > 0 ? labels.moreActive.replace("{count}", String(moreCount)) : labels.more}
            <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 text-muted transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
            {selects.map((s) => (
              <select
                key={s.name}
                aria-label={s.label}
                value={values[s.name] ?? ""}
                onChange={(e) => go({ [s.name]: e.target.value })}
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm"
              >
                {s.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ))}
          </div>
        </details>
      )}

      {active && (
        <Link href={path} replace scroll={false} className="inline-flex min-h-11 items-center text-sm text-primary underline">
          {labels.clear}
        </Link>
      )}
    </div>
  );
}
