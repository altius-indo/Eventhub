import Link from "next/link";
import { ListFilterBar } from "@/components/list-filter-bar";
import { MobileCollapse } from "@/components/mobile-collapse";
import { Alert, Badge, Card, CardTitle, LinkButton, PageHeader, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type Locale, type Translator } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { cleanGiftFilters, GIFT_CATEGORIES, GIFT_STATUSES, giftSummary, listGiftItems, type GiftRow, type GiftStatus } from "@/lib/gifts";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { quickBoughtAction, quickStatusAction } from "./actions";
import { giftStatusTone } from "./shared";

/** The next steps offered on a row, by status. */
const NEXT: Record<GiftStatus, { to: GiftStatus; key: "markOrdered" | "markBought" | "markGiven" | "reopen" }[]> = {
  to_buy: [
    { to: "ordered", key: "markOrdered" },
    { to: "bought", key: "markBought" },
  ],
  ordered: [{ to: "bought", key: "markBought" }],
  bought: [{ to: "given", key: "markGiven" }],
  given: [{ to: "to_buy", key: "reopen" }],
};

export default async function GiftsPage({ params, searchParams }: PageProps<"/events/[eventId]/gifts">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const filters = cleanGiftFilters(sp);
  const c = dctx(ctx);
  const [rows, summary, fns] = await Promise.all([listGiftItems(db, c, filters), giftSummary(db, c), listFunctions(db, eventId)]);
  const canEdit = ctx.can("gifts.manage");
  const base = `/events/${eventId}/gifts`;
  const query = new URLSearchParams(filters as Record<string, string>).toString();

  // Group by the day each gift is needed; undated last (rows are already in that order).
  const groups: { when: string | null; rows: GiftRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.when === r.when) last.rows.push(r);
    else groups.push({ when: r.when, rows: [r] });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("gifts.list")}
        subtitle={t("gifts.intro")}
        action={
          <div className="flex flex-wrap gap-2">
            {summary.items > 0 && (
              <a href={`${base}/export${query ? `?${query}` : ""}`} className={buttonClass("secondary")}>
                {t("gifts.export")}
              </a>
            )}
            {canEdit && <LinkButton href={`${base}/new`}>{t("gifts.add")}</LinkButton>}
          </div>
        }
      />

      {sp.saved === "1" && <Alert tone="success">{t("gifts.saved")}</Alert>}
      {sp.deleted === "1" && <Alert tone="success">{t("gifts.deleted")}</Alert>}

      {summary.items === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t("gifts.empty")}</p>
        </Card>
      ) : (
        <>
          <Card>
            <CardTitle>{t("gifts.summary.title")}</CardTitle>
            <p className="text-lg font-semibold">{t("gifts.summary.items", { done: summary.itemsDone, count: summary.items })}</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <span>{t("gifts.summary.needed", { count: summary.totalNeeded })}</span>
              <span>{t("gifts.summary.bought", { count: summary.totalBought })}</span>
              <span>{t("gifts.summary.remaining", { count: summary.remaining })}</span>
              {summary.estimatedCostPaise > 0 && <span>{t("gifts.summary.cost", { amount: formatInr(locale, summary.estimatedCostPaise) })}</span>}
            </div>
            {summary.dueSoon > 0 && (
              <Link href={`${base}?due=week`} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-warning hover:underline">
                {t("gifts.summary.dueSoon", { count: summary.dueSoon })}
              </Link>
            )}
          </Card>

          <Card>
            <MobileCollapse label={t("common.searchFilters")} activeLabel={t("common.filtersOn")} activeCount={Object.keys(filters).length}>
              <ListFilterBar
                values={filters as Record<string, string>}
                search={{ name: "q", label: t("gifts.search"), placeholder: t("gifts.search") }}
                tabs={{
                  name: "status",
                  label: t("gifts.statusLabel"),
                  options: [...GIFT_STATUSES.map((s) => ({ value: s, label: t(`gifts.statuses.${s}`) })), { value: "", label: t("gifts.allStatuses") }],
                }}
                chips={[
                  { label: t("gifts.chips.dueWeek"), set: { due: "week" } },
                  { label: t("gifts.chips.returnGifts"), set: { category: "return_gift" } },
                  { label: t("gifts.chips.mine"), set: { mine: "1" } },
                ]}
                selects={[
                  {
                    name: "fn",
                    label: t("gifts.fields.function"),
                    options: [{ value: "", label: t("gifts.anyFunction") }, ...fns.map((f) => ({ value: f.id, label: f.name })), { value: "none", label: t("gifts.notAtFunction") }],
                  },
                  {
                    name: "category",
                    label: t("gifts.fields.category"),
                    options: [{ value: "", label: t("gifts.anyCategory") }, ...GIFT_CATEGORIES.map((k) => ({ value: k, label: t(`gifts.categories.${k}`) }))],
                  },
                ]}
                labels={{ quick: t("gifts.filtersQuick"), more: t("gifts.filtersMore"), moreActive: t("gifts.filtersMoreActive"), clear: t("gifts.clear") }}
              />
            </MobileCollapse>
          </Card>

          {rows.length === 0 && (
            <Card>
              <p className="text-sm text-muted">{t("gifts.emptyFiltered")}</p>
            </Card>
          )}

          {groups.map((g) => (
            <section key={g.when ?? "none"} className="space-y-2">
              <h2 className="text-base font-semibold">{g.when ? formatDay(locale, g.when, { dateStyle: "full" }) : t("gifts.noDate")}</h2>
              <ul className="space-y-2">
                {g.rows.map((r) => (
                  <GiftRowCard key={r.id} r={r} t={t} locale={locale} eventId={eventId} canEdit={canEdit} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function GiftRowCard({ r, t, locale, eventId, canEdit }: { r: GiftRow; t: Translator; locale: Locale; eventId: string; canEdit: boolean }) {
  const pct = r.needed ? Math.min(100, Math.round((r.quantityBought / r.needed) * 100)) : r.status === "bought" || r.status === "given" ? 100 : 0;
  const families = r.recipients.slice(0, 3).map((h) => h.name).join(", ") + (r.recipients.length > 3 ? ` +${r.recipients.length - 3}` : "");
  const meta = [t(`gifts.categories.${r.category}`), r.functionName, r.giveBy ? t("gifts.giveByLine", { date: formatDay(locale, r.giveBy) }) : null].filter(Boolean).join(" · ");
  return (
    <li className="rounded-xl border border-border bg-surface p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {canEdit ? (
            <Link href={`/events/${eventId}/gifts/${r.id}`} className="inline-flex min-h-11 items-center font-medium break-words text-primary hover:underline">
              {r.name}
            </Link>
          ) : (
            <p className="font-medium break-words">{r.name}</p>
          )}
          <p className="text-sm text-muted break-words">{meta}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge tone={giftStatusTone[r.status]}>{t(`gifts.statuses.${r.status}`)}</Badge>
          {r.overdue ? <Badge tone="danger">{t("gifts.overdue")}</Badge> : r.dueSoon ? <Badge tone="warning">{t("gifts.dueSoon")}</Badge> : null}
        </div>
      </div>

      <div className="mt-2 space-y-0.5 text-sm">
        {r.forWhom && <p className="break-words">{t("gifts.forLine", { who: r.forWhom })}</p>}
        {r.recipients.length > 0 && <p className="break-words text-muted">{t("gifts.familiesLine", { names: families })}</p>}
        {r.assigneeName && <p className="text-muted">{t("gifts.assigneeLine", { name: r.assigneeName })}</p>}
        {r.unitCostPaise !== null && r.totalCostPaise !== null && (
          <p className="text-muted">{t("gifts.costLine", { amount: formatInr(locale, r.unitCostPaise), total: formatInr(locale, r.totalCostPaise) })}</p>
        )}
        {r.source && <p className="break-words text-muted">{t("gifts.shopLine", { shop: r.source })}</p>}
      </div>

      <div className="mt-2">
        <p className="text-sm font-medium">{r.needed === null ? t("gifts.needsFunction") : t("gifts.neededBought", { bought: r.quantityBought, needed: r.needed })}</p>
        <div
          className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={r.name}
        >
          <div className={`h-full rounded-full ${pct >= 100 ? "bg-success" : "bg-primary"}`} style={{ width: `${pct}%` }} />
        </div>
      </div>

      {canEdit && (
        <div role="group" aria-label={t("gifts.actions.quick", { name: r.name })} className="mt-3 flex flex-wrap items-center gap-2">
          {r.status !== "given" && (
            <>
              <form action={quickBoughtAction.bind(null, eventId, r.id, 1)}>
                <button type="submit" className={buttonClass("secondary", "px-3")}>
                  {t("gifts.actions.plusOne")}
                </button>
              </form>
              <form action={quickBoughtAction.bind(null, eventId, r.id, null)} className="flex items-center gap-1">
                <label htmlFor={`n-${r.id}`} className="sr-only">
                  {t("gifts.actions.addNLabel")}
                </label>
                <input
                  id={`n-${r.id}`}
                  name="n"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100000}
                  required
                  placeholder={t("gifts.actions.addNPlaceholder")}
                  className="min-h-11 w-20 rounded-lg border border-border bg-surface px-2 text-base"
                />
                <button type="submit" className={buttonClass("secondary", "px-3")}>
                  {t("gifts.actions.addN")}
                </button>
              </form>
            </>
          )}
          {NEXT[r.status].map((n) => (
            <form key={n.to} action={quickStatusAction.bind(null, eventId, r.id, n.to)}>
              <button type="submit" className={buttonClass(n.to === "to_buy" ? "ghost" : "secondary", "px-3")}>
                {t(`gifts.actions.${n.key}`)}
              </button>
            </form>
          ))}
        </div>
      )}
    </li>
  );
}
