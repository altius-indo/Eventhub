import { buttonClass, Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatInr, formatInrShort, type Locale, type Translator } from "@/i18n/core";
import { budgetFacts, byPayer, groupFacts, sumFacts, type Measures } from "@/lib/budget";
import { listServiceTypes } from "@/lib/catalogue";
import { listFunctions } from "@/lib/functions";
import { listVendors } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { typeLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

/** `variance` is off for vendors: estimates belong to requirements, not vendors, so a vendor's "planned" is always 0. */
function Table({ rows, t, locale, variance = true }: { rows: { key: string; label: string; m: Measures }[]; t: Translator; locale: Locale; variance?: boolean }) {
  const inr = (p: number) => formatInr(locale, p);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-2 pr-3 font-medium" />
            <th className="py-2 pr-3 text-right font-medium">{t("budget.planned")}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("budget.committed")}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("budget.invoiced")}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("budget.paid")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ key, label, m }) => {
            const over = variance && m.committed > m.planned && m.committed > 0;
            return (
              <tr key={key}>
                <td className="py-2 pr-3">
                  {label}
                  {m.pending !== 0 && <div className="text-xs text-warning">{t("services.pendingProposals", { amount: inr(m.pending) })}</div>}
                </td>
                <td className="py-2 pr-3 text-right">{inr(m.planned)}</td>
                <td className={`py-2 pr-3 text-right ${over ? "font-medium text-danger" : ""}`}>
                  {inr(m.committed)}
                  {over && <div className="text-xs">{t("budget.variance", { amount: inr(m.committed - m.planned) })}</div>}
                </td>
                <td className="py-2 pr-3 text-right">{inr(m.invoiced)}</td>
                <td className="py-2 pr-3 text-right">{inr(m.paid)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** BGT-05 dashboard: totals vs plan, by function, service type, vendor and payer. */
export default async function BudgetPage({ params }: PageProps<"/events/[eventId]/budget">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const [facts, fns, types, vendors] = await Promise.all([budgetFacts(db, eventId), listFunctions(db, eventId), listServiceTypes(db, eventId), listVendors(db, eventId, { includeArchived: true })]);
  const total = sumFacts(facts);
  const inr = (p: number) => formatInr(locale, p);
  const sort = (rows: { key: string; label: string; m: Measures }[]) => rows.filter((r) => r.m.planned || r.m.committed || r.m.invoiced || r.m.paid || r.m.pending);
  const byFn = groupFacts(facts, "functionId");
  const byCat = groupFacts(facts, "categoryId");
  const byVendor = groupFacts(facts, "vendorId");
  const payer = byPayer(facts);
  const tiles: [string, number, string?][] = [
    [t("budget.planned"), total.planned],
    [t("budget.committed"), total.committed, total.committed > total.planned ? "text-danger" : undefined],
    [t("budget.invoiced"), total.invoiced],
    [t("budget.paid"), total.paid, "text-success"],
    [t("budget.remaining"), Math.max(0, total.committed - total.paid)],
  ];
  const empty = !facts.length;
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("budget.title")}
        subtitle={t("budget.gstNote")}
        action={
          empty ? undefined : (
            <a href={`/events/${eventId}/budget/export`} className={buttonClass("secondary")}>
              {t("budget.export")}
            </a>
          )
        }
      />
      {empty ? (
        <Card>
          <p className="text-muted">{t("budget.empty")}</p>
        </Card>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {tiles.map(([label, v, cls]) => (
              <div key={label} className="rounded-xl border border-border bg-surface p-3">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className={`text-lg font-semibold ${cls ?? ""}`} title={inr(v)}>
                  {formatInrShort(locale, v)}
                </dd>
              </div>
            ))}
          </dl>
          {total.pending !== 0 && <p className="text-sm text-warning">{t("services.pendingProposals", { amount: inr(total.pending) })}</p>}
          <Card>
            <CardTitle>{t("budget.byFunction")}</CardTitle>
            <Table
              t={t}
              locale={locale}
              rows={sort([
                ...fns.map((f) => ({ key: f.id, label: f.name, m: byFn.get(f.id)! })).filter((r) => r.m),
                ...(byFn.get(null) ? [{ key: "none", label: t("budget.noFunction"), m: byFn.get(null)! }] : []),
              ])}
            />
          </Card>
          <Card>
            <CardTitle>{t("budget.byCategory")}</CardTitle>
            <Table
              t={t}
              locale={locale}
              rows={sort([
                ...types.map((ty) => ({ key: ty.id, label: typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name }), m: byCat.get(ty.id)! })).filter((r) => r.m),
                ...(byCat.get(null) ? [{ key: "none", label: t("budget.noCategory"), m: byCat.get(null)! }] : []),
              ])}
            />
          </Card>
          <Card>
            <CardTitle>{t("budget.byVendor")}</CardTitle>
            <Table
              t={t}
              locale={locale}
              variance={false}
              rows={sort([
                ...vendors.map((v) => ({ key: v.id, label: v.name, m: byVendor.get(v.id)! })).filter((r) => r.m),
                ...(byVendor.get(null) ? [{ key: "none", label: t("budget.noVendor"), m: byVendor.get(null)! }] : []),
              ])}
            />
          </Card>
          <Card>
            <CardTitle>{t("budget.byPayer")}</CardTitle>
            <Table
              t={t}
              locale={locale}
              rows={sort([
                { key: "bride", label: t("payer.bride"), m: payer.bride },
                { key: "groom", label: t("payer.groom"), m: payer.groom },
                { key: "unassigned", label: t("payer.unassigned"), m: payer.unassigned },
              ])}
            />
          </Card>
        </>
      )}
    </div>
  );
}
