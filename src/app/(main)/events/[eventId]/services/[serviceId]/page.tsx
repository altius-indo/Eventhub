import Link from "next/link";
import { notFound } from "next/navigation";
import { DocumentsPanel } from "@/components/documents-panel";
import { PayerFields } from "@/components/money-fields";
import { RequirementFields } from "@/components/requirement-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, LinkButton, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr, formatWallClock, type MessageKey } from "@/i18n/core";
import { listDocuments } from "@/lib/documents";
import { listMembers } from "@/lib/events";
import { getFunction, listFunctions } from "@/lib/functions";
import { isUuid } from "@/lib/ids";
import { compareForService } from "@/lib/quotes";
import { headcounts } from "@/lib/rsvp";
import { getService, ServiceError } from "@/lib/services";
import { getEventContext } from "@/lib/server/event-context";
import { documentLabels, eventToday, payerLabels, payerText, requirementLabels, serviceLabel, statusTone } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import {
  addRequirementAction,
  cancelRequirementAction,
  cancelServiceAction,
  copyServiceAction,
  deliveredAction,
  updateRequirementAction,
  updateServiceAction,
} from "../actions";

export default async function ServicePage({ params, searchParams }: PageProps<"/events/[eventId]/services/[serviceId]">) {
  const { eventId, serviceId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!isUuid(serviceId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const s = await getService(db, eventId, serviceId).catch((e) => {
    if (e instanceof ServiceError) notFound();
    throw e;
  });
  const [fn, fns, members, cmp, docs] = await Promise.all([
    getFunction(db, eventId, s.functionId),
    listFunctions(db, eventId),
    listMembers(db, eventId),
    compareForService(db, eventId, s.id),
    listDocuments(db, eventId, { serviceId: s.id }),
  ]);
  const canEdit = ctx.can("services.edit") && s.approvalState !== "rejected" && !s.cancelledAt;
  const isOwner = s.ownerUserId === ctx.user.id;
  const canDeliver = isOwner || ctx.decide("services.edit") === "allow";
  const labels = requirementLabels(t);
  const hc = s.typeKey === "catering" ? (await headcounts(db, eventId)).get(s.functionId) : undefined;
  const today = eventToday(ctx.event.timezone);
  const owner = members.find((m) => m.user.id === s.ownerUserId);

  return (
    <div className="space-y-4">
      <PageHeader
        title={serviceLabel(t, s)}
        subtitle={`${fn.name}${fn.date ? ` · ${formatDay(locale, fn.date)}` : ""}${owner ? ` · ${t("services.owner")}: ${owner.user.name ?? "—"}` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone[s.status]}>{t(`services.status.${s.status}` as MessageKey)}</Badge>
            {s.pendingChange && <Badge tone="warning">{t("services.pendingChange")}</Badge>}
          </div>
        }
      />

      {hc && (
        <Alert tone="neutral">
          {t("services.headcount", { count: hc.attending + hc.maybe, attending: hc.attending, maybe: hc.maybe })} {t("services.headcountHint")}
        </Alert>
      )}

      <Card>
        <CardTitle>{t("services.requirements")}</CardTitle>
        {s.requirements.length === 0 ? (
          <p className="text-sm text-muted">{t("services.noRequirements")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {s.requirements.map((r) => {
              const c = r.coverage;
              const live = !["rejected", "cancelled"].includes(r.status);
              return (
                <li key={r.id} className="space-y-2 py-3 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.title}</span>
                    {r.quantity != null && (
                      <span className="text-sm text-muted">
                        {r.quantity} {r.unit ?? ""}
                      </span>
                    )}
                    <Badge tone={statusTone[r.status]}>{t(`services.status.${r.status}` as MessageKey)}</Badge>
                    {r.priority === "nice" && <Badge>{t("services.priorities.nice")}</Badge>}
                    {r.pendingChange && <Badge tone="warning">{t("services.pendingChange")}</Badge>}
                  </div>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
                    {r.estimatePaise != null && <span>{t("services.planned", { amount: formatInr(locale, r.estimatePaise) })}</span>}
                    {c && c.committedPaise > 0 && <span>{t("services.committed", { amount: formatInr(locale, c.committedPaise) })}</span>}
                    {c && (c.full ? <span>{t("services.coverageFull")}</span> : r.quantity != null && c.confirmedQty > 0 && <span>{t("services.coverage", { covered: c.confirmedQty, quantity: r.quantity })}</span>)}
                    {c && (c.tentativeQty > 0 || c.tentativeFull) && <span className="text-warning">{t("services.tentative", { quantity: c.tentativeFull ? "✓" : c.tentativeQty })}</span>}
                    {r.startsAt && <span>{formatWallClock(locale, r.startsAt, { dateStyle: "medium", timeStyle: "short" })}</span>}
                    {r.venue && <span>{r.venue}</span>}
                    {r.payer && <span>{payerText(t, locale, r.payer)}</span>}
                  </p>
                  {r.specs && <p className="whitespace-pre-line text-sm">{r.specs}</p>}
                  <div className="flex flex-wrap gap-2">
                    {canDeliver && r.status !== "proposed" && live && (
                      <form action={deliveredAction.bind(null, eventId, r.id, r.status !== "delivered")}>
                        <SubmitButton variant="secondary">{r.status === "delivered" ? t("services.undoDelivered") : t("services.markDelivered")}</SubmitButton>
                      </form>
                    )}
                  </div>
                  {canEdit && live && (
                    <details>
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("services.editRequirement")}</summary>
                      <SimpleForm action={updateRequirementAction.bind(null, eventId, r.id)} className="mt-2 space-y-3">
                        <RequirementFields labels={labels} value={r} id={`r-${r.id}`} />
                        <SubmitButton>{t("common.save")}</SubmitButton>
                      </SimpleForm>
                      <SimpleForm action={cancelRequirementAction.bind(null, eventId, r.id)} className="mt-3 flex flex-wrap items-end gap-2">
                        <Field label={t("services.cancelReason")} htmlFor={`cr-${r.id}`}>
                          <Input id={`cr-${r.id}`} name="reason" maxLength={500} />
                        </Field>
                        <SubmitButton variant="secondary" className="text-danger">
                          {t("services.cancel")}
                        </SubmitButton>
                      </SimpleForm>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && (
          <details className="mt-3 border-t border-border pt-3">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("services.addRequirement")}</summary>
            <SimpleForm action={addRequirementAction.bind(null, eventId, s.id)} className="mt-2 space-y-3">
              <RequirementFields labels={labels} id="new-req" />
              <SubmitButton>{t("services.addRequirement")}</SubmitButton>
            </SimpleForm>
          </details>
        )}
      </Card>

      <Card>
        <CardTitle
          action={
            s.approvalState === "approved" && !s.cancelledAt && ctx.can("vendors.edit") ? (
              <LinkButton href={`/events/${eventId}/vendors/requests/new?service=${s.id}`} variant="secondary">
                {t("services.requestQuotes")}
              </LinkButton>
            ) : undefined
          }
        >
          {t("services.quotes")}
        </CardTitle>
        {cmp.quotes.length === 0 ? (
          <p className="text-sm text-muted">{t("services.noQuotes")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">{t("quotes.pickVendors")}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t("quotes.total")}</th>
                  {cmp.requirements.map((r) => (
                    <th key={r.id} className="py-2 pr-3 font-medium">
                      {r.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {cmp.quotes.map((q) => (
                  <tr key={q.quote.id} className={q.quote.declinedAt ? "opacity-60" : ""}>
                    <td className="py-2 pr-3">
                      <Link href={`/events/${eventId}/vendors/quotes/${q.quote.id}`} className="font-medium text-primary underline">
                        {q.vendorName}
                      </Link>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {q.partOfPackage && <Badge tone="primary">{t("services.partOfPackage")}</Badge>}
                        {q.quote.declinedAt && <Badge>{t("services.declined")}</Badge>}
                        {q.quote.validUntil && q.quote.validUntil < today && <Badge tone="warning">{t("services.expiredQuote")}</Badge>}
                        {q.missing > 0 ? <Badge tone="warning">{t("services.missing", { count: q.missing })}</Badge> : <Badge tone="success">{t("services.coversAll")}</Badge>}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right font-medium">
                      {formatInr(locale, q.total)}
                      {q.partOfPackage && <div className="text-xs font-normal text-muted">{t("services.packageTotal", { amount: formatInr(locale, q.packageTotal) })}</div>}
                    </td>
                    {q.perRequirement.map((p) => (
                      <td key={p.requirementId} className="py-2 pr-3">
                        {p.covered ? (
                          <>
                            {formatInr(locale, p.amount)}
                            {p.quantity != null && <div className="text-xs text-muted">× {p.quantity}</div>}
                          </>
                        ) : (
                          <span className="text-warning">{t("services.notCovered")}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {ctx.can("services.edit") && s.approvalState !== "rejected" && (
        <Card>
          <CardTitle>{t("services.brief")}</CardTitle>
          <SimpleForm action={updateServiceAction.bind(null, eventId, s.id)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("services.label")} htmlFor="svc-name" hint={t("services.labelHelp")}>
                <Input id="svc-name" name="name" maxLength={60} defaultValue={s.name ?? ""} />
              </Field>
              <Field label={t("services.owner")} htmlFor="svc-owner">
                <Select id="svc-owner" name="ownerUserId" defaultValue={s.ownerUserId ?? ""}>
                  <option value="">{t("services.noOwner")}</option>
                  {members.map((m) => (
                    <option key={m.user.id} value={m.user.id}>
                      {m.user.name ?? "—"}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={t("services.brief")} htmlFor="svc-brief">
              <Textarea id="svc-brief" name="brief" rows={4} maxLength={4000} defaultValue={s.brief ?? ""} />
            </Field>
            <PayerFields labels={payerLabels(t)} value={s.payer} id="svc-payer" />
            <SubmitButton>{t("common.save")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}

      <DocumentsPanel
        eventId={eventId}
        owner="serviceId"
        ownerId={s.id}
        docs={docs}
        canEdit={ctx.can("contracts.edit")}
        back={`/events/${eventId}/services/${s.id}`}
        defaultKind="brief"
        labels={documentLabels(t, t("services.documents"), sp)}
      />

      {canEdit && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardTitle>{t("services.copyTo")}</CardTitle>
            <SimpleForm action={copyServiceAction.bind(null, eventId, s.id)} className="flex flex-wrap items-end gap-2">
              <Field label={t("budget.function")} htmlFor="copy-fn">
                <Select id="copy-fn" name="functionId">
                  {fns
                    .filter((f) => f.id !== s.functionId)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <SubmitButton variant="secondary">{t("services.copy")}</SubmitButton>
            </SimpleForm>
          </Card>
          <Card>
            <CardTitle>{t("services.cancelService")}</CardTitle>
            <SimpleForm action={cancelServiceAction.bind(null, eventId, s.id)} className="flex flex-wrap items-end gap-2">
              <Field label={t("services.cancelReason")} htmlFor="cancel-svc">
                <Input id="cancel-svc" name="reason" maxLength={500} />
              </Field>
              <SubmitButton variant="secondary" className="text-danger">
                {t("services.cancel")}
              </SubmitButton>
            </SimpleForm>
          </Card>
        </div>
      )}
    </div>
  );
}
