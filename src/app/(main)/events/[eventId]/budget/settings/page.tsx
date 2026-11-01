import { MoneyInput } from "@/components/money-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardTitle, Field, PageHeader, Select } from "@/components/ui";
import { getDb } from "@/db";
import { formatInr } from "@/i18n/core";
import { listServiceTypes } from "@/lib/catalogue";
import { GST_STATES } from "@/lib/money";
import { getEventContext } from "@/lib/server/event-context";
import { typeLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { settingsAction } from "../actions";

/** BGT-04 approval limits (Hosts only), GST place of supply and PAY-05 reminder recipients. */
export default async function BudgetSettingsPage({ params }: PageProps<"/events/[eventId]/budget/settings">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const types = await listServiceTypes(getDb(), eventId);
  const isHost = ctx.decide("budget.thresholds") === "allow";
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={t("budget.settings")} />
      {!isHost && <Alert tone="neutral">{t("budget.thresholdsHostOnly")}</Alert>}
      {isHost ? (
        <SimpleForm action={settingsAction.bind(null, eventId, types.map((x) => x.id))}>
          <Card className="space-y-3">
            <CardTitle>{t("budget.thresholds")}</CardTitle>
            <p className="text-sm text-muted">{t("budget.thresholdsHelp")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {types.map((ty) => (
                <Field key={ty.id} label={typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name })} htmlFor={`th_${ty.id}`}>
                  <MoneyInput id={`th_${ty.id}`} name={`th_${ty.id}`} value={ty.autoApproveBelowPaise} />
                </Field>
              ))}
            </div>
          </Card>
          <Card className="space-y-3">
            <Field label={t("budget.placeOfSupply")} htmlFor="pos" hint={t("budget.placeOfSupplyHelp")}>
              <Select id="pos" name="placeOfSupply" defaultValue={ctx.event.placeOfSupply ?? ""}>
                <option value="">—</option>
                {Object.entries(GST_STATES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {code} · {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("budget.reminders")} htmlFor="rem">
              <Select id="rem" name="paymentRemindersTo" defaultValue={ctx.event.paymentRemindersTo}>
                <option value="hosts">{t("budget.remindersTo.hosts")}</option>
                <option value="hosts_planners">{t("budget.remindersTo.hosts_planners")}</option>
              </Select>
            </Field>
          </Card>
          <SubmitButton>{t("common.save")}</SubmitButton>
        </SimpleForm>
      ) : (
        <Card>
          <CardTitle>{t("budget.thresholds")}</CardTitle>
          <ul className="space-y-1 text-sm">
            {types.map((ty) => (
              <li key={ty.id} className="flex justify-between gap-2">
                <span>{typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name })}</span>
                <span>{formatInr(locale, ty.autoApproveBelowPaise)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
