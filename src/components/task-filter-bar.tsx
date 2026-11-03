"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export type TaskFilterValues = {
  q: string;
  status: "open" | "done" | "all";
  /** "", "me", "none" or a member id */
  assignee: string;
  fn: string;
  due: "" | "overdue" | "week";
  high: boolean;
};

type Option = { id: string; name: string | null };

export type TaskFilterLabels = {
  search: string;
  searchPlaceholder: string;
  quick: string;
  open: string;
  done: string;
  all: string;
  mine: string;
  unassigned: string;
  overdue: string;
  week: string;
  high: string;
  anyone: string;
  anyFunction: string;
  assignee: string;
  fn: string;
  clear: string;
  status: string;
};

/** Builds the tasks URL for a set of filters; empty values are left out. */
export function taskFilterHref(path: string, v: TaskFilterValues) {
  const p = new URLSearchParams();
  if (v.q.trim()) p.set("q", v.q.trim());
  if (v.status !== "open") p.set("status", v.status);
  if (v.assignee) p.set("assignee", v.assignee);
  if (v.fn) p.set("fn", v.fn);
  if (v.due) p.set("due", v.due);
  if (v.high) p.set("high", "1");
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

const chip = (on: boolean) =>
  `inline-flex min-h-11 items-center rounded-full border px-3 text-sm ${
    on ? "border-primary bg-primary text-white" : "border-border bg-surface text-text hover:bg-surface-muted"
  }`;

/**
 * Task filters (ITN-05): search applies as you type, status tabs and quick chips are plain links
 * (work without JavaScript), and the assignee/function selects apply on change.
 */
export function TaskFilterBar({
  values,
  counts,
  members,
  functions,
  labels,
}: {
  values: TaskFilterValues;
  counts: { open: number; done: number; all: number };
  members: Option[];
  functions: Option[];
  labels: TaskFilterLabels;
}) {
  const router = useRouter();
  const path = usePathname();
  const [q, setQ] = useState(values.q);
  const [seenQ, setSeenQ] = useState(values.q);
  const [sentQ, setSentQ] = useState(values.q);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the box in sync when the search changes by navigation ("Clear filters", Back), but not
  // when it's just our own search arriving while the person is still typing.
  if (values.q !== seenQ) {
    setSeenQ(values.q);
    if (values.q !== sentQ) setQ(values.q);
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const go = (next: Partial<TaskFilterValues>) => {
    const target = { ...values, q, ...next };
    setSentQ(target.q.trim());
    startTransition(() => router.replace(taskFilterHref(path, target), { scroll: false }));
  };

  const onSearch = (text: string) => {
    setQ(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go({ q: text }), 300);
  };

  const href = (next: Partial<TaskFilterValues>) => taskFilterHref(path, { ...values, q, ...next });
  const active = !!(values.q || values.assignee || values.fn || values.due || values.high);

  return (
    <div className="space-y-3" aria-busy={pending}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (timer.current) clearTimeout(timer.current);
          go({ q });
        }}
      >
        <label htmlFor="task-q" className="sr-only">
          {labels.search}
        </label>
        <input
          id="task-q"
          name="q"
          type="search"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={labels.searchPlaceholder}
          autoComplete="off"
          className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
      </form>

      <nav aria-label={labels.status} className="flex rounded-lg border border-border bg-surface-muted p-1">
        {(["open", "done", "all"] as const).map((s) => (
          <Link
            key={s}
            href={href({ status: s })}
            replace
            scroll={false}
            aria-current={values.status === s ? "page" : undefined}
            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium ${
              values.status === s ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-text"
            }`}
          >
            {labels[s]}
            <span className="text-xs text-muted">{counts[s]}</span>
          </Link>
        ))}
      </nav>

      <div role="group" aria-label={labels.quick} className="flex flex-wrap gap-2">
        <Link replace scroll={false} href={href({ assignee: values.assignee === "me" ? "" : "me" })} className={chip(values.assignee === "me")} aria-pressed={values.assignee === "me"}>
          {labels.mine}
        </Link>
        <Link replace scroll={false} href={href({ due: values.due === "overdue" ? "" : "overdue" })} className={chip(values.due === "overdue")} aria-pressed={values.due === "overdue"}>
          {labels.overdue}
        </Link>
        <Link replace scroll={false} href={href({ due: values.due === "week" ? "" : "week" })} className={chip(values.due === "week")} aria-pressed={values.due === "week"}>
          {labels.week}
        </Link>
        <Link replace scroll={false} href={href({ assignee: values.assignee === "none" ? "" : "none" })} className={chip(values.assignee === "none")} aria-pressed={values.assignee === "none"}>
          {labels.unassigned}
        </Link>
        <Link replace scroll={false} href={href({ high: !values.high })} className={chip(values.high)} aria-pressed={values.high}>
          {labels.high}
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label={labels.assignee}
          value={values.assignee === "me" || values.assignee === "none" ? "" : values.assignee}
          onChange={(e) => go({ assignee: e.target.value })}
          className="min-h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm"
        >
          <option value="">{labels.anyone}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name ?? "—"}
            </option>
          ))}
        </select>
        <select
          aria-label={labels.fn}
          value={values.fn}
          onChange={(e) => go({ fn: e.target.value })}
          disabled={functions.length === 0}
          className="min-h-11 w-full rounded-lg border border-border bg-surface px-2 text-sm disabled:opacity-60"
        >
          <option value="">{labels.anyFunction}</option>
          {functions.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>

      {active && (
        <Link replace scroll={false} href={taskFilterHref(path, { q: "", status: values.status, assignee: "", fn: "", due: "", high: false })} className="inline-flex min-h-11 items-center text-sm text-primary underline">
          {labels.clear}
        </Link>
      )}
    </div>
  );
}
