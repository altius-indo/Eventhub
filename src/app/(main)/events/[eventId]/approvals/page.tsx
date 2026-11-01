import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Select, Textarea, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import type { ApprovalRequest } from "@/db/schema";
import Link from "next/link";
import { formatDateTime, formatInr, translateDynamic, type Locale, type Translator } from "@/i18n/core";
import { APPROVAL_TYPES } from "@/lib/approval-handlers";
import { bookingOverspend } from "@/lib/bookings";
import { listServiceTypes } from "@/lib/catalogue";
import { listFunctions } from "@/lib/functions";
import { isUuid } from "@/lib/ids";
import { entityLinks, loadApprovals } from "@/lib/server/approvals-query";
import { typeLabel } from "@/lib/server/money-form";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { decideAction, withdrawAction } from "./actions";

const statusTone = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  changes_requested: "warning",
  cancelled: "neutral",
} as const;

type Row = Awaited<ReturnType<typeof loadApprovals>>[number];

type Extra = { link: string | null; functions: string; overPlan: string[] };

function Summary({ row, t, locale, extra }: { row: Row; t: Translator; locale: Locale; extra: Extra }) {
  const r: ApprovalRequest = row.request;
  const typeText = translateDynamic(locale, `approvals.types.${r.type}`);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {typeText && <Badge tone="primary">{typeText}</Badge>}
        {extra.link ? (
          <Link href={extra.link} className="font-medium text-primary underline">
            {r.title}
          </Link>
        ) : (
          <span className="font-medium">{r.title}</span>
        )}
        {extra.functions && <span className="text-sm text-muted">{extra.functions}</span>}
        <Badge tone={statusTone[r.status]}>{t(`approvals.status.${r.status}`)}</Badge>
        {r.amountPaise != null && <Badge>{formatInr(locale, r.amountPaise)}</Badge>}
      </div>
      <p className="mt-0.5 text-sm text-muted">
        {t("approvals.requestedBy", { name: row.requesterName ?? "—" })} · {formatDateTime(locale, r.createdAt)}
      </p>
      {extra.overPlan.map((o) => (
        <p key={o} className="mt-1 text-sm font-medium text-danger">
          {o}
        </p>
      ))}
      {row.lastDecision?.decision.comment && (
        <p className="mt-1 rounded-md bg-surface-muted px-2 py-1 text-sm">
          {row.lastDecision.deciderName}: {row.lastDecision.decision.comment}
        </p>
      )}
    </div>
  );
}

export default async function ApprovalsPage({ params, searchParams }: PageProps<"/events/[eventId]/approvals">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const canDecide = ctx.can("approvals.decide");
  const type = typeof sp.type === "string" && (APPROVAL_TYPES as readonly string[]).includes(sp.type) ? sp.type : undefined;
  const functionId = typeof sp.fn === "string" && isUuid(sp.fn) ? sp.fn : undefined;
  const db = getDb();
  const [rows, fns, cats] = await Promise.all([
    loadApprovals(db, eventId, { onlyRequestedBy: canDecide ? undefined : ctx.user.id, type, functionId }),
    listFunctions(db, eventId),
    listServiceTypes(db, eventId),
  ]);
  const link = await entityLinks(db, eventId, rows.map((r) => r.request));
  const extras = new Map<string, Extra>();
  for (const row of rows) {
    const r = row.request;
    const overPlan =
      r.status === "pending" && r.type === "booking.create" && r.entityId
        ? (await bookingOverspend(db, eventId, r.entityId)).map((o) => {
            const c = cats.find((x) => x.id === o.categoryId);
            return t("approvals.overPlan", { category: c ? typeLabel(t, { typeKey: c.systemKey, typeName: c.name }) : "", amount: formatInr(locale, o.overBy) });
          })
        : [];
    extras.set(r.id, { link: link(r), functions: r.functionIds.map((id) => fns.find((f) => f.id === id)?.name).filter(Boolean).join(", "), overPlan });
  }
  const pending = rows.filter((r) => r.request.status === "pending");
  const others = rows.filter((r) => r.request.status !== "pending");

  return (
    <div className="space-y-4">
      <form className="flex flex-wrap items-end gap-2" role="search">
        <Field label={t("approvals.filterType")} htmlFor="f-type">
          <Select id="f-type" name="type" defaultValue={type ?? ""}>
            <option value="">{t("approvals.allTypes")}</option>
            {APPROVAL_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {translateDynamic(locale, `approvals.types.${ty}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("approvals.filterFunction")} htmlFor="f-fn">
          <Select id="f-fn" name="fn" defaultValue={functionId ?? ""}>
            <option value="">{t("approvals.allFunctions")}</option>
            {fns.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <button type="submit" className={buttonClass("secondary")}>
          {t("approvals.filter")}
        </button>
      </form>
      <Card>
        <CardTitle>{canDecide ? t("approvals.queue") : t("approvals.mine")}</CardTitle>
        {pending.length === 0 ? (
          <p className="text-muted">{t("approvals.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((row) => (
              <li key={row.request.id} className="space-y-3 py-3 first:pt-0 last:pb-0">
                <Summary row={row} t={t} locale={locale} extra={extras.get(row.request.id)!} />
                {canDecide && row.request.type === "payment.record" && <p className="text-xs text-muted">{t("approvals.stepUpNote")}</p>}
                {canDecide ? (
                  <SimpleForm action={decideAction.bind(null, eventId)} className="space-y-2">
                    <input type="hidden" name="requestId" value={row.request.id} />
                    <Field label={t("approvals.comment")} htmlFor={`comment-${row.request.id}`}>
                      <Textarea id={`comment-${row.request.id}`} name="comment" rows={2} />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <SubmitButton name="decision" value="approve">
                        {t("approvals.approve")}
                      </SubmitButton>
                      <SubmitButton name="decision" value="request_changes" variant="secondary">
                        {t("approvals.requestChanges")}
                      </SubmitButton>
                      <SubmitButton name="decision" value="reject" variant="ghost" className="text-danger">
                        {t("approvals.reject")}
                      </SubmitButton>
                    </div>
                  </SimpleForm>
                ) : (
                  row.request.requestedBy === ctx.user.id && (
                    <form action={withdrawAction.bind(null, eventId)}>
                      <input type="hidden" name="requestId" value={row.request.id} />
                      <SubmitButton variant="secondary">{t("approvals.withdraw")}</SubmitButton>
                    </form>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {others.length > 0 && (
        <Card>
          <CardTitle>{t("approvals.history")}</CardTitle>
          <ul className="divide-y divide-border">
            {others.map((row) => (
              <li key={row.request.id} className="py-3 first:pt-0 last:pb-0">
                <Summary row={row} t={t} locale={locale} extra={extras.get(row.request.id)!} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
