import { notFound } from "next/navigation";
import { MoneyInput } from "@/components/money-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, PageHeader, Select } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime, formatInr } from "@/i18n/core";
import { giftMembers, listHandovers, openCash } from "@/lib/gifts";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { handoverAction } from "../actions";

/** Cash reconciliation per collector and function (GFT-03). Record-only collectors see their own. */
export default async function CashPage({ params, searchParams }: PageProps<"/events/[eventId]/gifts/cash">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const c = dctx(ctx);
  const [open, handovers, members] = await Promise.all([openCash(db, c), listHandovers(db, c), giftMembers(db, c)]);
  const inr = (p: number) => formatInr(locale, p);

  return (
    <div className="space-y-4">
      <PageHeader title={t("gifts.cash.title")} subtitle={t("gifts.cash.help")} />
      {sp.handover === "ok" && <Alert tone="success">{t("gifts.cash.matched")}</Alert>}
      {sp.handover === "flagged" && <Alert tone="warning">{t("gifts.cash.flagged")}</Alert>}

      <Card>
        <CardTitle>{t("gifts.cash.open")}</CardTitle>
        {open.length === 0 ? (
          <p className="text-sm text-muted">{t("gifts.cash.nothingOpen")}</p>
        ) : (
          <ul className="space-y-4">
            {open.map((o) => {
              const id = `${o.functionId ?? "none"}-${o.collectorUserId ?? "none"}`;
              return (
                <li key={id} className="rounded-lg border border-border p-3">
                  <p className="font-medium">
                    {o.functionName ?? t("gifts.noFunction")} · {o.collectorName ?? t("audit.system")}
                  </p>
                  <p className="mb-2 text-sm text-muted">{t("gifts.cash.recorded", { amount: inr(o.totalPaise), count: o.count })}</p>
                  {o.collectorUserId && (
                    <SimpleForm action={handoverAction.bind(null, eventId, o.functionId, o.collectorUserId)} className="grid gap-3 sm:grid-cols-2">
                      <Field label={t("gifts.cash.counted")} htmlFor={`counted-${id}`}>
                        <MoneyInput id={`counted-${id}`} name="counted" required />
                      </Field>
                      <Field label={t("gifts.cash.handedTo")} htmlFor={`to-${id}`}>
                        <Select id={`to-${id}`} name="handedTo" defaultValue="">
                          <option value="">{t("gifts.cash.someoneElse")}</option>
                          {members
                            .filter((m) => m.userId !== o.collectorUserId)
                            .map((m) => (
                              <option key={m.userId} value={m.userId}>
                                {m.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                      <Field label={t("gifts.cash.handedToName")} htmlFor={`toname-${id}`}>
                        <Input id={`toname-${id}`} name="handedToName" maxLength={120} />
                      </Field>
                      <Field label={t("gifts.notes")} htmlFor={`notes-${id}`}>
                        <Input id={`notes-${id}`} name="notes" maxLength={500} />
                      </Field>
                      <div className="sm:col-span-2">
                        <SubmitButton>{t("gifts.cash.record")}</SubmitButton>
                      </div>
                    </SimpleForm>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>{t("gifts.cash.history")}</CardTitle>
        {handovers.length === 0 ? (
          <p className="text-sm text-muted">{t("gifts.cash.noHandovers")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {handovers.map((h) => {
              const diff = h.countedPaise - h.recordedTotalPaise;
              const changed = h.currentTotalPaise !== h.recordedTotalPaise;
              return (
                <li key={h.id} className="space-y-1 py-2.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {h.functionName ?? t("gifts.noFunction")} · {h.collectorName ?? t("audit.system")}
                    </span>
                    {diff === 0 ? <Badge tone="success">{t("gifts.cash.ok")}</Badge> : <Badge tone="danger">{t("gifts.cash.discrepancy", { amount: `${diff < 0 ? "−" : "+"}${inr(Math.abs(diff))}` })}</Badge>}
                    {changed && <Badge tone="warning">{t("gifts.cash.changedSince", { amount: inr(h.currentTotalPaise) })}</Badge>}
                  </p>
                  <p className="text-sm text-muted">
                    {t("gifts.cash.line", { recorded: inr(h.recordedTotalPaise), counted: inr(h.countedPaise), to: h.handedToName ?? "—", time: formatDateTime(locale, h.handedAt) })}
                  </p>
                  {h.notes && <p className="text-sm">{h.notes}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
