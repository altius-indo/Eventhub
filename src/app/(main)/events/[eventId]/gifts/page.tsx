import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, CardTitle, Input, LinkButton, PageHeader, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type Locale, type Translator } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { cleanGiftFilters, GIFT_TYPES, giftSummary, giverLabel, householdsWithoutGift, listGifts, RECEIVED_FOR, thankedStats, type GiftRow, type GiftTotals } from "@/lib/gifts";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { forLabel, typeLabel } from "./shared";

function value(t: Translator, locale: Locale, g: GiftRow) {
  if (g.amountPaise) return formatInr(locale, g.amountPaise);
  return [g.itemDescription, g.estValuePaise ? t("gifts.approx", { amount: formatInr(locale, g.estValuePaise) }) : null].filter(Boolean).join(" · ");
}

function TotalsTable({ title, rows, label, locale, t }: { title: string; rows: GiftTotals[]; label: (r: GiftTotals) => string; locale: Locale; t: Translator }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t("gifts.empty")}</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-1.5 pr-2 font-medium">{title}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{t("gifts.count")}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{t("gifts.amount")}</th>
                <th className="py-1.5 text-right font-medium">{t("gifts.estValue")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.key}-${i}`} className="border-t border-border">
                  <td className="py-1.5 pr-2">{label(r)}</td>
                  <td className="py-1.5 pr-2 text-right">{r.count}</td>
                  <td className="py-1.5 pr-2 text-right">{formatInr(locale, r.amountPaise)}</td>
                  <td className="py-1.5 text-right">{r.estValuePaise ? formatInr(locale, r.estValuePaise) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default async function GiftsPage({ params, searchParams }: PageProps<"/events/[eventId]/gifts">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const c = dctx(ctx);
  const full = ctx.can("gifts.view");
  const filters = cleanGiftFilters(sp);
  const [rows, fns] = await Promise.all([listGifts(db, c, filters), listFunctions(db, eventId)]);
  const [summary, missing, thanked] = full ? await Promise.all([giftSummary(db, c), householdsWithoutGift(db, c), thankedStats(db, eventId)]) : [null, null, null];
  const base = `/events/${eventId}/gifts`;
  const erased = t("gifts.erasedGiver");

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("gifts.title")}
        subtitle={full ? t("gifts.privateNote") : t("gifts.ownOnly")}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`${base}/envelope`} variant="secondary">
              {t("gifts.envelope.open")}
            </LinkButton>
            <LinkButton href={`${base}/new`}>{t("gifts.add")}</LinkButton>
          </div>
        }
      />
      {sp.saved === "1" && <Alert tone="success">{t("common.saved")}</Alert>}
      {sp.deleted === "1" && <Alert tone="success">{t("gifts.deleted")}</Alert>}
      {typeof sp.imported === "string" && /^\d+$/.test(sp.imported) && <Alert tone="success">{t("gifts.import.done", { count: sp.imported })}</Alert>}

      {summary && thanked && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [t("gifts.totalCash"), formatInr(locale, summary.total.amountPaise)],
              [t("gifts.totalItems"), summary.total.estValuePaise ? formatInr(locale, summary.total.estValuePaise) : "—"],
              [t("gifts.count"), String(summary.total.count)],
              [t("gifts.thankedPct"), `${thanked.pct}%`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border bg-surface p-3">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="text-lg font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted">{t("gifts.notBudget")}</p>
          <div className="grid gap-4 lg:grid-cols-3">
            <TotalsTable title={t("gifts.function")} rows={summary.byFunction} label={(r) => r.label ?? t("gifts.noFunction")} locale={locale} t={t} />
            <TotalsTable title={t("gifts.receivedFor")} rows={summary.byReceivedFor} label={(r) => forLabel(t, r.key ?? "other")} locale={locale} t={t} />
            <TotalsTable title={t("gifts.type")} rows={summary.byType} label={(r) => typeLabel(t, r.key ?? "other")} locale={locale} t={t} />
          </div>
          {missing && (
            <Card>
              <details>
                <summary className="min-h-11 cursor-pointer py-2 font-semibold">{t("gifts.noGiftTitle", { count: missing.length })}</summary>
                <p className="mb-2 text-sm text-muted">{t("gifts.noGiftHelp")}</p>
                <ul className="divide-y divide-border text-sm">
                  {missing.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-center gap-2 py-1.5">
                      <span>{h.name}</span>
                      {h.attended && <Badge tone="primary">{t("gifts.attended")}</Badge>}
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          )}
        </>
      )}

      <Card>
        <CardTitle>{full ? t("gifts.register") : t("gifts.myEntries")}</CardTitle>
        <form method="get" className="mb-3 grid gap-2 sm:grid-cols-6" role="search">
          <Input name="q" defaultValue={filters.q ?? ""} placeholder={t("gifts.search")} aria-label={t("gifts.search")} className="sm:col-span-2" />
          <Select name="fn" defaultValue={filters.fn ?? ""} aria-label={t("gifts.function")}>
            <option value="">{t("gifts.allFunctions")}</option>
            {fns.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="none">{t("gifts.noFunction")}</option>
          </Select>
          <Select name="type" defaultValue={filters.type ?? ""} aria-label={t("gifts.type")}>
            <option value="">{t("gifts.allTypes")}</option>
            {GIFT_TYPES.map((k) => (
              <option key={k} value={k}>
                {typeLabel(t, k)}
              </option>
            ))}
          </Select>
          <Select name="for" defaultValue={filters.for ?? ""} aria-label={t("gifts.receivedFor")}>
            <option value="">{t("gifts.allFor")}</option>
            {RECEIVED_FOR.map((k) => (
              <option key={k} value={k}>
                {forLabel(t, k)}
              </option>
            ))}
          </Select>
          <div className="flex gap-2">
            <button type="submit" className={buttonClass("secondary", "flex-1")}>
              {t("gifts.filter")}
            </button>
            {Object.keys(filters).length > 0 && (
              <Link href={base} className={buttonClass("ghost")}>
                {t("guests.clear")}
              </Link>
            )}
          </div>
        </form>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t("gifts.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((g) => (
              <li key={g.id}>
                <Link href={`${base}/${g.id}`} className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-2 hover:text-primary">
                  <span className="font-medium">{giverLabel(g, erased)}</span>
                  <span className="text-sm text-muted">
                    {[typeLabel(t, g.type), g.functionName, g.envelopeNo && t("gifts.envelopeShort", { no: g.envelopeNo }), g.receivedOn && formatDay(locale, g.receivedOn)].filter(Boolean).join(" · ")}
                  </span>
                  <span className="ml-auto text-sm">{value(t, locale, g)}</span>
                  {g.handedOver && <Badge tone="success">{t("gifts.handedOver")}</Badge>}
                  {full && g.recordedByName && <span className="w-full text-xs text-muted">{t("gifts.recordedBy", { name: g.recordedByName })}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
