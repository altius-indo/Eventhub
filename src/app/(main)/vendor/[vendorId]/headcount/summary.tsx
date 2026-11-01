import type { Translator } from "@/i18n/core";
import type { CatererView } from "@/lib/caterer-headcount";

const DIETS = ["veg", "non_veg", "jain", "vegan", "other", "unknown"] as const;

/** Rows of the aggregate headcount (shared by the page, the printable view and the Excel export). */
export function headcountRows(t: Translator, v: CatererView): { label: string; value: number; group: string }[] {
  const s = v.snapshot;
  return [
    { group: t("headcount.expected"), label: t("vendorPortal.bookings.total"), value: v.total },
    { group: t("headcount.expected"), label: t("headcount.confirmed"), value: s.confirmed },
    { group: t("headcount.expected"), label: t("headcount.maybe"), value: s.maybe },
    { group: t("headcount.expected"), label: t("headcount.pending"), value: s.pending },
    { group: t("headcount.ages"), label: t("headcount.adults"), value: s.adults },
    { group: t("headcount.ages"), label: t("headcount.children"), value: s.children },
    { group: t("headcount.ages"), label: t("headcount.infants"), value: s.infants },
    ...DIETS.map((d) => ({ group: t("headcount.meals"), label: t(`headcount.diet.${d}`), value: s.diet[d] ?? 0 })),
    { group: t("headcount.meals"), label: t("headcount.allergies"), value: s.allergies },
  ];
}

export function HeadcountSummary({ t, view }: { t: Translator; view: CatererView }) {
  const rows = headcountRows(t, view);
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {groups.map((g) => (
        <section key={g} className="rounded-xl border border-border bg-surface p-4">
          <h2 className="mb-2 text-sm font-semibold">{g}</h2>
          <dl className="space-y-1 text-sm">
            {rows
              .filter((r) => r.group === g)
              .map((r) => (
                <div key={r.label} className="flex justify-between gap-2">
                  <dt className="text-muted">{r.label}</dt>
                  <dd className="font-semibold tabular-nums">{r.value}</dd>
                </div>
              ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
