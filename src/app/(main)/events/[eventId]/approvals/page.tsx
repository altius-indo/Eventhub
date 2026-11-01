import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import type { ApprovalRequest } from "@/db/schema";
import { formatDateTime, formatInr, type Locale, type Translator } from "@/i18n/core";
import { loadApprovals } from "@/lib/server/approvals-query";
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

function Summary({ row, t, locale }: { row: Row; t: Translator; locale: Locale }) {
  const r: ApprovalRequest = row.request;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.title}</span>
        <Badge tone={statusTone[r.status]}>{t(`approvals.status.${r.status}`)}</Badge>
        {r.amountPaise != null && <Badge>{formatInr(locale, r.amountPaise)}</Badge>}
      </div>
      <p className="mt-0.5 text-sm text-muted">
        {t("approvals.requestedBy", { name: row.requesterName ?? "—" })} · {formatDateTime(locale, r.createdAt)}
      </p>
      {row.lastDecision?.decision.comment && (
        <p className="mt-1 rounded-md bg-surface-muted px-2 py-1 text-sm">
          {row.lastDecision.deciderName}: {row.lastDecision.decision.comment}
        </p>
      )}
    </div>
  );
}

export default async function ApprovalsPage({ params }: PageProps<"/events/[eventId]/approvals">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const canDecide = ctx.can("approvals.decide");
  const rows = await loadApprovals(getDb(), eventId, { onlyRequestedBy: canDecide ? undefined : ctx.user.id });
  const pending = rows.filter((r) => r.request.status === "pending");
  const others = rows.filter((r) => r.request.status !== "pending");

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>{canDecide ? t("approvals.queue") : t("approvals.mine")}</CardTitle>
        {pending.length === 0 ? (
          <p className="text-muted">{t("approvals.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {pending.map((row) => (
              <li key={row.request.id} className="space-y-3 py-3 first:pt-0 last:pb-0">
                <Summary row={row} t={t} locale={locale} />
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
                <Summary row={row} t={t} locale={locale} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
