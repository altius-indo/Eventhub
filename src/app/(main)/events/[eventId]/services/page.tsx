import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Input, PageHeader, Select } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, type MessageKey } from "@/i18n/core";
import { budgetFacts, groupFacts } from "@/lib/budget";
import { ensureCatalogue, listServiceTypes } from "@/lib/catalogue";
import { listMembers } from "@/lib/events";
import { listFunctions } from "@/lib/functions";
import { listServices } from "@/lib/services";
import { getEventContext } from "@/lib/server/event-context";
import { serviceLabel, statusTone, typeLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { addServiceAction } from "./actions";

export default async function ServicesPage({ params }: PageProps<"/events/[eventId]/services">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  await ensureCatalogue(db, eventId, locale);
  const [fns, svcs, types, members, facts] = await Promise.all([
    listFunctions(db, eventId),
    listServices(db, eventId),
    listServiceTypes(db, eventId, "service"),
    listMembers(db, eventId),
    budgetFacts(db, eventId),
  ]);
  const byFn = groupFacts(facts, "functionId");
  const canEdit = ctx.can("services.edit");

  return (
    <div className="space-y-4">
      <PageHeader title={t("services.title")} />
      {fns.length === 0 && (
        <Card>
          <p className="text-muted">{t("dashboard.noFunctions")}</p>
        </Card>
      )}
      {fns.map((fn) => {
        const list = svcs.filter((s) => s.functionId === fn.id);
        const m = byFn.get(fn.id);
        return (
          <Card key={fn.id}>
            <CardTitle>
              {fn.name}
              {fn.date && <span className="ml-2 text-sm font-normal text-muted">{formatDay(locale, fn.date)}</span>}
            </CardTitle>
            {m && (m.planned || m.committed || m.pending) ? (
              <p className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                <span>{t("services.planned", { amount: formatInr(locale, m.planned) })}</span>
                <span>{t("services.committed", { amount: formatInr(locale, m.committed) })}</span>
                {m.pending !== 0 && <span className="text-warning">{t("services.pendingProposals", { amount: formatInr(locale, m.pending) })}</span>}
              </p>
            ) : null}
            {list.length === 0 ? (
              <p className="text-sm text-muted">{t("services.empty")}</p>
            ) : (
              <ul className="divide-y divide-border">
                {list.map((s) => {
                  const live = s.requirements.filter((r) => !["rejected", "cancelled"].includes(r.status));
                  return (
                    <li key={s.id}>
                      <Link href={`/events/${eventId}/services/${s.id}`} className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:text-primary">
                        <span className="font-medium">{serviceLabel(t, s)}</span>
                        <Badge tone={statusTone[s.status]}>{t(`services.status.${s.status}` as MessageKey)}</Badge>
                        {s.pendingChange && <Badge tone="warning">{t("services.pendingChange")}</Badge>}
                        <span className="text-sm text-muted">
                          {t("services.requirements")}: {live.length}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {canEdit && (
              <details className="mt-3">
                <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("services.add")}</summary>
                <SimpleForm action={addServiceAction.bind(null, eventId, fn.id)} className="mt-2 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("services.type")} htmlFor={`type-${fn.id}`}>
                      <Select id={`type-${fn.id}`} name="serviceTypeId" required>
                        {types.map((ty) => (
                          <option key={ty.id} value={ty.id}>
                            {typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name })}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t("services.label")} htmlFor={`name-${fn.id}`} hint={t("services.labelHelp")}>
                      <Input id={`name-${fn.id}`} name="name" maxLength={60} />
                    </Field>
                    <Field label={t("services.owner")} htmlFor={`owner-${fn.id}`}>
                      <Select id={`owner-${fn.id}`} name="ownerUserId" defaultValue={ctx.user.id}>
                        <option value="">{t("services.noOwner")}</option>
                        {members.map((mm) => (
                          <option key={mm.user.id} value={mm.user.id}>
                            {mm.user.name ?? "—"}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" name="useTemplates" defaultChecked className="h-5 w-5" />
                    {t("services.useTemplates")}
                  </label>
                  <SubmitButton>{t("services.add")}</SubmitButton>
                </SimpleForm>
              </details>
            )}
          </Card>
        );
      })}
    </div>
  );
}
