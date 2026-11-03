import { and, eq, ne } from "drizzle-orm";
import { ConfirmButton } from "@/components/confirm-button";
import { BudgetLineFields } from "@/components/budget-line-fields";
import { PaymentFields } from "@/components/payment-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { budgetLines } from "@/db/schema";
import { formatDay, formatInr } from "@/i18n/core";
import { listServiceTypes } from "@/lib/catalogue";
import { listFunctions } from "@/lib/functions";
import { listPayments } from "@/lib/payments";
import { getEventContext } from "@/lib/server/event-context";
import { eventToday, payerLabels, payerText, paymentLabels, typeLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { addLineAction, deleteLineAction, recordPaymentAction, updateLineAction } from "../actions";

/** BGT-02: costs not tied to a service, with payments against them. */
export default async function BudgetLinesPage({ params }: PageProps<"/events/[eventId]/budget/lines">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const [lines, types, fns, pays] = await Promise.all([
    db.select().from(budgetLines).where(and(eq(budgetLines.eventId, eventId), ne(budgetLines.approvalState, "rejected"))).orderBy(budgetLines.createdAt),
    listServiceTypes(db, eventId),
    listFunctions(db, eventId),
    listPayments(db, eventId),
  ]);
  const cats = types.map((ty) => ({ id: ty.id, label: typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name }), standalone: ty.kind === "standalone" }));
  const ordered = [...cats.filter((c) => c.standalone), ...cats.filter((c) => !c.standalone)];
  const labels = {
    title: t("budget.lineTitle"),
    category: t("budget.category"),
    function: t("budget.function"),
    anyFunction: t("budget.anyFunction"),
    estimate: t("services.estimate"),
    notes: t("payments.notes"),
    payer: payerLabels(t),
  };
  const canEdit = ctx.can("budget.edit");
  const today = eventToday(ctx.event.timezone);
  return (
    <div className="space-y-4">
      <PageHeader title={t("budget.lines")} subtitle={t("catalogue.standaloneHelp")} />
      <Card>
        {lines.length === 0 ? (
          <p className="text-muted">{t("budget.lineEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {lines.map((l) => {
              const mine = pays.filter((p) => p.payment.budgetLineId === l.id);
              const paid = mine.filter((p) => p.payment.state === "confirmed").reduce((a, p) => a + p.payment.amountPaise, 0);
              return (
                <li key={l.id} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{l.title}</span>
                    <span>{formatInr(locale, l.estimatePaise)}</span>
                    <span className="text-sm text-muted">
                      {cats.find((c) => c.id === l.categoryId)?.label}
                      {l.functionId && ` · ${fns.find((f) => f.id === l.functionId)?.name ?? ""}`} · {payerText(t, locale, l.payer)}
                    </span>
                    {l.approvalState === "proposed" && <Badge tone="warning">{t("services.status.proposed")}</Badge>}
                    {paid > 0 && <Badge tone="success">{`${t("budget.paid")}: ${formatInr(locale, paid)}`}</Badge>}
                  </div>
                  {mine.length > 0 && (
                    <ul className="text-sm text-muted">
                      {mine.map(({ payment: p }) => (
                        <li key={p.id}>
                          {formatDay(locale, p.paidOn)} · {formatInr(locale, p.amountPaise)} · {t(`payments.modes.${p.mode}`)} · {t(`payments.states.${p.state}`)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canEdit && (
                    <details>
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("services.editRequirement")}</summary>
                      <SimpleForm action={updateLineAction.bind(null, eventId, l.id)} className="mt-2 space-y-3">
                        <BudgetLineFields labels={labels} value={l} id={`l-${l.id}`} categories={ordered} functions={fns} />
                        <SubmitButton>{t("common.save")}</SubmitButton>
                      </SimpleForm>
                      <SimpleForm action={deleteLineAction.bind(null, eventId, l.id)} className="mt-2">
                        <ConfirmButton variant="ghost" className="text-danger" confirm={t("budget.deleteConfirm")}>
                          {t("common.delete")}
                        </ConfirmButton>
                      </SimpleForm>
                    </details>
                  )}
                  {l.approvalState === "approved" && ctx.can("payments.record") && (
                    <details>
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("budget.recordPayment")}</summary>
                      <SimpleForm action={recordPaymentAction.bind(null, eventId, { budgetLineId: l.id })} className="mt-2 space-y-3">
                        <PaymentFields labels={paymentLabels(t)} today={today} id={`p-${l.id}`} invoices={[]} overpay={false} />
                        <SubmitButton>{t("payments.record")}</SubmitButton>
                      </SimpleForm>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {canEdit && (
        <Card>
          <CardTitle>{t("budget.lineAdd")}</CardTitle>
          <SimpleForm action={addLineAction.bind(null, eventId)} className="space-y-3">
            <BudgetLineFields labels={labels} id="new-line" categories={ordered} functions={fns} />
            <SubmitButton>{t("budget.lineAdd")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
