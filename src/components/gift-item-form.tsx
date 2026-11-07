"use client";

import { useMemo, useState } from "react";
import { SimpleForm } from "./simple-form";
import { SubmitButton } from "./submit-button";
import { Field, Input, Select, Textarea } from "./ui";

type Mode = "fixed" | "per_family" | "per_guest" | "per_adult";
type State = { error?: string; info?: string };
type Counts = { households: number; guests: number; adults: number };

export type GiftFormLabels = Record<
  | "name"
  | "namePlaceholder"
  | "description"
  | "category"
  | "function"
  | "noFunction"
  | "giveBy"
  | "giveByHelp"
  | "quantity"
  | "quantityFixed"
  | "quantityFunction"
  | "sameFunction"
  | "quantityExtra"
  | "quantityExtraHelp"
  | "forWhom"
  | "forWhomPlaceholder"
  | "recipients"
  | "recipientsHelp"
  | "recipientsSearch"
  | "recipientsCount"
  | "unitCost"
  | "assignee"
  | "nobody"
  | "source"
  | "sourcePlaceholder"
  | "notes"
  | "save",
  string
> & {
  modes: Record<Mode, string>;
  /** Templates with {function}, {count}, {extra}, {total}. */
  hint: Record<"per_family" | "per_guest" | "per_adult" | "spare" | "total" | "noFunction", string>;
};

export type GiftFormValue = {
  name: string;
  description: string | null;
  category: string;
  functionId: string | null;
  giveBy: string | null;
  quantityMode: Mode;
  quantityFixed: number | null;
  quantityFunctionId: string | null;
  quantityExtra: number;
  forWhom: string | null;
  unitCostRupees: string;
  assigneeId: string | null;
  source: string | null;
  notes: string | null;
  householdIds: string[];
};

const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
const MODES: Mode[] = ["fixed", "per_family", "per_guest", "per_adult"];

/** Add / edit a gift to give (GFT-01..05), with a live "how many" hint from the guest list. */
export function GiftItemForm({
  action,
  labels,
  categories,
  functions,
  counts,
  households,
  members,
  value,
}: {
  action: (prev: State, fd: FormData) => Promise<State>;
  labels: GiftFormLabels;
  categories: { value: string; label: string }[];
  functions: { id: string; name: string }[];
  counts: Record<string, Counts>;
  households: { id: string; name: string }[];
  members: { id: string; name: string }[];
  value?: GiftFormValue;
}) {
  const [mode, setMode] = useState<Mode>(value?.quantityMode ?? "fixed");
  const [fnId, setFnId] = useState(value?.functionId ?? "");
  const [qtyFnId, setQtyFnId] = useState(value?.quantityFunctionId ?? "");
  const [fixed, setFixed] = useState(value?.quantityFixed != null ? String(value.quantityFixed) : "");
  const [extra, setExtra] = useState(String(value?.quantityExtra ?? 0));
  const [picked, setPicked] = useState<Set<string>>(new Set(value?.householdIds ?? []));
  const [q, setQ] = useState("");

  const hint = useMemo(() => {
    if (mode === "fixed") return fixed && /^\d+$/.test(fixed) ? fill(labels.hint.total, { total: Number(fixed) }) : "";
    const id = qtyFnId || fnId;
    const fn = functions.find((f) => f.id === id);
    if (!fn) return labels.hint.noFunction;
    const c = counts[id] ?? { households: 0, guests: 0, adults: 0 };
    const count = mode === "per_family" ? c.households : mode === "per_guest" ? c.guests : c.adults;
    const spare = /^\d+$/.test(extra) ? Number(extra) : 0;
    const parts = [fill(labels.hint[mode], { function: fn.name, count })];
    if (spare > 0) parts.push(fill(labels.hint.spare, { extra: spare }));
    parts.push(`· ${fill(labels.hint.total, { total: count + spare })}`);
    return parts.join(" ");
  }, [mode, fixed, qtyFnId, fnId, extra, functions, counts, labels.hint]);

  const needle = q.trim().toLowerCase();
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <SimpleForm action={action}>
      <Field label={labels.name} htmlFor="gift-name">
        <Input id="gift-name" name="name" required maxLength={120} defaultValue={value?.name ?? ""} placeholder={labels.namePlaceholder} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={labels.category} htmlFor="gift-category">
          <Select id="gift-category" name="category" defaultValue={value?.category ?? "return_gift"}>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.forWhom} htmlFor="gift-for">
          <Input id="gift-for" name="forWhom" maxLength={200} defaultValue={value?.forWhom ?? ""} placeholder={labels.forWhomPlaceholder} />
        </Field>
        <Field label={labels.function} htmlFor="gift-fn">
          <Select id="gift-fn" name="functionId" value={fnId} onChange={(e) => setFnId(e.target.value)}>
            <option value="">{labels.noFunction}</option>
            {functions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.giveBy} htmlFor="gift-giveby" hint={labels.giveByHelp}>
          <Input id="gift-giveby" name="giveBy" type="date" defaultValue={value?.giveBy ?? ""} />
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">{labels.quantity}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => (
            <label key={m} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft">
              <input type="radio" name="quantityMode" value={m} checked={mode === m} onChange={() => setMode(m)} className="h-4 w-4" />
              {labels.modes[m]}
            </label>
          ))}
        </div>
        {mode === "fixed" ? (
          <Field label={labels.quantityFixed} htmlFor="gift-qty">
            <Input id="gift-qty" name="quantityFixed" type="number" inputMode="numeric" min={0} max={100000} required value={fixed} onChange={(e) => setFixed(e.target.value)} className="sm:max-w-40" />
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={labels.quantityFunction} htmlFor="gift-qtyfn">
              <Select id="gift-qtyfn" name="quantityFunctionId" value={qtyFnId} onChange={(e) => setQtyFnId(e.target.value)}>
                <option value="">{labels.sameFunction}</option>
                {functions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={labels.quantityExtra} htmlFor="gift-extra" hint={labels.quantityExtraHelp}>
              <Input id="gift-extra" name="quantityExtra" type="number" inputMode="numeric" min={0} max={100000} value={extra} onChange={(e) => setExtra(e.target.value)} />
            </Field>
          </div>
        )}
        {hint && (
          <p className="text-sm font-medium text-primary" aria-live="polite">
            {hint}
          </p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={labels.unitCost} htmlFor="gift-cost">
          <Input id="gift-cost" name="unitCost" inputMode="decimal" maxLength={16} defaultValue={value?.unitCostRupees ?? ""} />
        </Field>
        <Field label={labels.assignee} htmlFor="gift-assignee">
          <Select id="gift-assignee" name="assigneeId" defaultValue={value?.assigneeId ?? ""}>
            <option value="">{labels.nobody}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={labels.source} htmlFor="gift-source">
          <Input id="gift-source" name="source" maxLength={300} defaultValue={value?.source ?? ""} placeholder={labels.sourcePlaceholder} />
        </Field>
      </div>

      <Field label={labels.description} htmlFor="gift-desc">
        <Textarea id="gift-desc" name="description" maxLength={1000} rows={2} defaultValue={value?.description ?? ""} />
      </Field>

      {households.length > 0 && (
        <fieldset className="space-y-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{labels.recipients}</legend>
          <p className="text-sm text-muted">{labels.recipientsHelp}</p>
          <label htmlFor="gift-recip-q" className="sr-only">
            {labels.recipientsSearch}
          </label>
          <Input id="gift-recip-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={labels.recipientsSearch} autoComplete="off" />
          <p className="text-sm text-muted" aria-live="polite">
            {fill(labels.recipientsCount, { count: picked.size })}
          </p>
          <ul className="max-h-60 overflow-y-auto rounded-lg border border-border">
            {households.map((h) => (
              <li key={h.id} hidden={!!needle && !picked.has(h.id) && !h.name.toLowerCase().includes(needle)}>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-surface-muted">
                  <input type="checkbox" name="householdIds" value={h.id} checked={picked.has(h.id)} onChange={() => toggle(h.id)} className="h-4 w-4" />
                  <span className="min-w-0 break-words">{h.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <Field label={labels.notes} htmlFor="gift-notes">
        <Textarea id="gift-notes" name="notes" maxLength={1000} rows={2} defaultValue={value?.notes ?? ""} />
      </Field>
      <SubmitButton>{labels.save}</SubmitButton>
    </SimpleForm>
  );
}
