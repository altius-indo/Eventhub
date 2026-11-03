import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { translateDynamic } from "@/i18n/core";
import { getFunction, NotFoundError } from "@/lib/functions";
import { seatingPlan } from "@/lib/seating";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { addTablesAction, deleteTableAction, seatAction, unseatAction, updateTableAction } from "./actions";
import { isUuid } from "@/lib/ids";

const sideTone = { bride: "primary", groom: "success", both: "neutral" } as const;

export default async function SeatingPage({ params }: PageProps<"/events/[eventId]/schedule/[functionId]/seating">) {
  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(functionId)) notFound();
  const db = getDb();
  const fn = await getFunction(db, eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const plan = await seatingPlan(db, eventId, functionId);
  const { t, locale } = await getTranslator();
  const canEdit = ctx.can("seating.edit");
  const families = new Map<string, typeof plan.unassigned>();
  for (const g of plan.unassigned) families.set(g.householdId, [...(families.get(g.householdId) ?? []), g]);
  const dietSummary = (gs: (typeof plan.tables)[number]["guests"]) =>
    (["veg", "non_veg", "jain", "vegan", "other"] as const)
      .map((d) => [d, gs.filter((g) => g.diet === d).length] as const)
      .filter(([, n]) => n > 0)
      .map(([d, n]) => `${t(`diets.${d}`)} ${n}`)
      .join(" · ");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/events/${eventId}/schedule`} className="text-sm text-primary hover:underline">
            ← {t("schedule.title")}
          </Link>
          <h2 className="text-xl font-semibold">{t("seating.forFunction", { name: fn.name })}</h2>
          <p className="text-sm text-muted">{t("seating.progress", { seated: plan.seated, invited: plan.invited })}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/events/${eventId}/schedule/${functionId}/seating/export`} className={buttonClass("secondary")}>
            {t("seating.export")}
          </a>
          <Link href={`/events/${eventId}/schedule/${functionId}/seating/print`} className={buttonClass("secondary")}>
            {t("logistics.print")}
          </Link>
        </div>
      </div>
      {plan.warnings.map((w, i) => (
        <Alert key={i} tone="warning">
          {translateDynamic(locale, `seating.warnings.${w.code}`, w as unknown as Record<string, string>)}
        </Alert>
      ))}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {plan.tables.length === 0 && (
            <Card>
              <p className="text-muted">{t("seating.empty")}</p>
            </Card>
          )}
          <ul className="grid gap-3 sm:grid-cols-2">
            {plan.tables.map((table) => (
              <li key={table.id}>
                <Card className={table.seatsUsed > table.capacity ? "border-danger" : undefined}>
                  <CardTitle action={<Badge tone={table.seatsUsed > table.capacity ? "danger" : "neutral"}>{t("seating.seats", { used: table.seatsUsed, capacity: table.capacity })}</Badge>}>
                    {table.name}
                  </CardTitle>
                  <ul className="space-y-1 text-sm">
                    {table.guests.map((g) => (
                      <li key={g.id} className="flex items-center justify-between gap-2">
                        <span>
                          {g.name} <span className="text-muted">· {g.householdName}</span>
                          {g.ageGroup !== "adult" && <span className="text-muted"> · {t(`ages.${g.ageGroup}`)}</span>}
                        </span>
                        {canEdit && (
                          <form action={unseatAction.bind(null, eventId, functionId, g.id)}>
                            <button type="submit" className="min-h-9 rounded-md px-2 text-xs text-danger hover:bg-danger-soft">
                              {t("seating.remove")}
                            </button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                  {table.guests.length > 0 && <p className="mt-2 text-xs text-muted">{dietSummary(table.guests)}</p>}
                  {canEdit && (
                    <details className="mt-2 border-t border-border pt-2">
                      <summary className="inline-flex min-h-10 cursor-pointer items-center text-xs text-primary">{t("runsheet.edit")}</summary>
                      <SimpleForm action={updateTableAction.bind(null, eventId, functionId, table.id)} className="mt-2 flex gap-2">
                        <Input name="name" defaultValue={table.name} aria-label={t("seating.prefix")} className="min-h-9 text-sm" maxLength={60} />
                        <Input name="capacity" type="number" min={1} max={100} defaultValue={table.capacity} aria-label={t("seating.capacity")} className="min-h-9 w-20 text-sm" />
                        <SubmitButton variant="secondary" className="min-h-9 px-2 text-xs">
                          {t("seating.rename")}
                        </SubmitButton>
                      </SimpleForm>
                      <form action={deleteTableAction.bind(null, eventId, functionId, table.id)} className="mt-2">
                        <ConfirmButton variant="ghost" className="min-h-9 text-xs text-danger" confirm={t("seating.deleteConfirm")}>
                          {t("seating.deleteTable")}
                        </ConfirmButton>
                      </form>
                    </details>
                  )}
                </Card>
              </li>
            ))}
          </ul>
          {canEdit && (
            <Card>
              <CardTitle>{t("seating.addTables")}</CardTitle>
              <SimpleForm action={addTablesAction.bind(null, eventId, functionId)} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                <Field label={t("seating.prefix")} htmlFor="prefix">
                  <Input id="prefix" name="prefix" defaultValue={t("seating.prefixDefault")} maxLength={40} />
                </Field>
                <Field label={t("seating.count")} htmlFor="count">
                  <Input id="count" name="count" type="number" min={1} max={100} defaultValue={10} />
                </Field>
                <Field label={t("seating.capacity")} htmlFor="capacity">
                  <Input id="capacity" name="capacity" type="number" min={1} max={100} defaultValue={10} />
                </Field>
                <SubmitButton>{t("seating.addTables")}</SubmitButton>
              </SimpleForm>
            </Card>
          )}
        </div>

        <Card>
          <CardTitle>{t("seating.unassigned")}</CardTitle>
          <p className="mb-3 text-sm text-muted">{t("seating.unassignedHelp")}</p>
          {plan.unassigned.length === 0 ? (
            <p className="text-sm">{t("seating.allSeated")}</p>
          ) : canEdit && plan.tables.length > 0 ? (
            <SimpleForm action={seatAction.bind(null, eventId, functionId)} className="space-y-3">
              <ul className="max-h-[28rem] space-y-2 overflow-y-auto">
                {[...families.values()].map((members) => (
                  <li key={members[0].householdId}>
                    <label className="flex min-h-10 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
                      <input type="checkbox" name="householdIds" value={members[0].householdId} className="h-5 w-5" aria-label={`${t("seating.seatFamily")}: ${members[0].householdName}`} />
                      {members[0].householdName} <Badge tone={sideTone[members[0].side]}>{t(`sides.${members[0].side}`)}</Badge>
                    </label>
                    {members.map((g) => (
                      <label key={g.id} className="flex min-h-10 items-center gap-2 text-sm">
                        <input type="checkbox" name="guestIds" value={g.id} className="h-5 w-5" />
                        {g.name}
                        {g.ageGroup !== "adult" && <span className="text-muted">({t(`ages.${g.ageGroup}`)})</span>}
                        {g.accessibilityNotes && <Badge tone="warning">♿</Badge>}
                      </label>
                    ))}
                  </li>
                ))}
              </ul>
              <Field label={t("seating.seatAt")} htmlFor="tableId">
                <Select id="tableId" name="tableId">
                  {plan.tables.map((tb) => (
                    <option key={tb.id} value={tb.id}>
                      {tb.name} ({tb.seatsUsed}/{tb.capacity})
                    </option>
                  ))}
                </Select>
              </Field>
              <p className="text-xs text-muted">{t("seating.seatFamily")}: ☑ {t("importer.fields.household")}</p>
              <SubmitButton className="w-full">
                {t("seating.seatAt")}
              </SubmitButton>
            </SimpleForm>
          ) : (
            <ul className="space-y-1 text-sm">
              {plan.unassigned.map((g) => (
                <li key={g.id}>
                  {g.name} <span className="text-muted">· {g.householdName}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
