import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, LinkButton, PageHeader, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime, type MessageKey } from "@/i18n/core";
import { thankedStats } from "@/lib/gifts";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { listTemplates, listTracker, trackerFilterKeys, type TrackerFilters } from "@/lib/thank-yous";
import { statusTone } from "../shared";
import { draftManyAction } from "./actions";

/** Thank-you tracker (GFT-08) with % thanked (GFT-10). */
export default async function ThankYousPage({ params, searchParams }: PageProps<"/events/[eventId]/gifts/thank-yous">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const c = dctx(ctx);
  const filters: TrackerFilters = {};
  for (const k of trackerFilterKeys) if (typeof sp[k] === "string" && sp[k]) filters[k] = String(sp[k]).slice(0, 60);
  const [rows, stats, templates] = await Promise.all([listTracker(db, c, filters), thankedStats(db, eventId), listTemplates(db, c)]);
  const base = `/events/${eventId}/gifts/thank-yous`;
  const qs = new URLSearchParams(filters as Record<string, string>).toString();

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("thankYous.title")}
        subtitle={t("thankYous.progress", { pct: stats.pct, sent: stats.sent, total: stats.total - stats.notNeeded })}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`${base}/templates`} variant="secondary">
              {t("thankYous.templates")}
            </LinkButton>
            <LinkButton href={`${base}/labels${qs ? `?${qs}` : ""}`} variant="secondary">
              {t("thankYous.labels")}
            </LinkButton>
            <LinkButton href={`${base}/send`}>{t("thankYous.reviewSend", { count: stats.drafted })}</LinkButton>
          </div>
        }
      />
      {typeof sp.sent === "string" && <Alert tone="success">{t("thankYous.sentInfo", { count: sp.sent, skipped: String(sp.skipped ?? "0") })}</Alert>}

      <Card>
        <form method="get" className="grid gap-2 sm:grid-cols-5" role="search">
          <Input name="q" defaultValue={filters.q ?? ""} placeholder={t("gifts.search")} aria-label={t("gifts.search")} className="sm:col-span-2" />
          <Select name="status" defaultValue={filters.status ?? ""} aria-label={t("thankYous.status")}>
            <option value="">{t("thankYous.allStatuses")}</option>
            {(["not_started", "drafted", "sent", "not_needed"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`thankYous.statuses.${s}`)}
              </option>
            ))}
          </Select>
          <Select name="gift" defaultValue={filters.gift ?? ""} aria-label={t("thankYous.giftFilter")}>
            <option value="">{t("thankYous.anyGift")}</option>
            <option value="yes">{t("thankYous.gaveGift")}</option>
            <option value="no">{t("thankYous.noGift")}</option>
          </Select>
          <div className="flex gap-2">
            <Select name="attended" defaultValue={filters.attended ?? ""} aria-label={t("gifts.attended")}>
              <option value="">{t("thankYous.anyAttendance")}</option>
              <option value="yes">{t("gifts.attended")}</option>
            </Select>
            <button type="submit" className={buttonClass("secondary")}>
              {t("gifts.filter")}
            </button>
          </div>
        </form>
      </Card>

      {templates.length > 0 ? (
        <Card>
          <CardTitle>{t("thankYous.draftMany")}</CardTitle>
          <p className="mb-3 text-sm text-muted">{t("thankYous.draftManyHelp")}</p>
          <SimpleForm action={draftManyAction.bind(null, eventId, filters as Record<string, string>)} className="flex flex-wrap items-end gap-2">
            <Field label={t("thankYous.template")} htmlFor="tpl">
              <Select id="tpl" name="templateId" required>
                {templates.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name} ({t(`languages.${tp.locale as "en"}`)})
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton variant="secondary">{t("thankYous.draftManyButton")}</SubmitButton>
          </SimpleForm>
        </Card>
      ) : (
        <Alert tone="neutral">
          {t("thankYous.noTemplates")}{" "}
          <Link href={`${base}/templates`} className="underline">
            {t("thankYous.templates")}
          </Link>
        </Alert>
      )}

      <Card>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t("thankYous.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.householdId}>
                <Link href={`${base}/${r.householdId}`} className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:text-primary">
                  <span className="font-medium">{r.householdName}</span>
                  <Badge tone={statusTone[r.status]}>{t(`thankYous.statuses.${r.status}`)}</Badge>
                  {r.giftCount > 0 && <Badge tone="primary">{t("thankYous.gifts", { count: r.giftCount })}</Badge>}
                  {r.attended && <Badge>{t("gifts.attended")}</Badge>}
                  {r.delivery && r.delivery !== "sent" && <Badge tone={r.delivery === "failed" ? "danger" : "neutral"}>{t(`thankYous.delivery.${r.delivery}` as MessageKey)}</Badge>}
                  {r.sentAt && (
                    <span className="ml-auto text-xs text-muted">
                      {[r.channel && t(`thankYous.channels.${r.channel}`), formatDateTime(locale, r.sentAt), r.sentByName].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
