"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { approvalRequests } from "@/db/schema";
import "@/lib/approval-handlers";
import { ApprovalError, decideRequest, withdrawRequest } from "@/lib/approvals";
import { hasRecentStepUp } from "@/lib/auth-core";
import { isUuid } from "@/lib/ids";
import { BookingError } from "@/lib/bookings";
import { BudgetError } from "@/lib/budget";
import { PaymentError } from "@/lib/payments";
import { ForbiddenError } from "@/lib/policy";
import { QuoteError } from "@/lib/quotes";
import { ServiceError } from "@/lib/services";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

export async function decideAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const decision = formData.get("decision");
  const requestId = String(formData.get("requestId"));
  if ((decision !== "approve" && decision !== "reject" && decision !== "request_changes") || !isUuid(requestId)) return { error: t("common.somethingWrong") };
  // Approving a payment needs a fresh one-time code (EVT-01d).
  if (decision === "approve") {
    const [req] = await getDb()
      .select({ type: approvalRequests.type })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.eventId, eventId)));
    if (req?.type === "payment.record" && !hasRecentStepUp(ctx.session)) redirect(`/step-up?next=${encodeURIComponent(`/events/${eventId}/approvals`)}`);
  }
  try {
    await decideRequest(getDb(), {
      eventId,
      requestId,
      actor: ctx.actor,
      subject: ctx.subject,
      decision,
      comment: String(formData.get("comment") ?? ""),
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: t("common.notAllowed") };
    if (err instanceof ApprovalError) {
      if (err.code === "comment_required") return { error: t("approvals.commentRequired") };
      if (err.code === "stale") return { error: t("approvals.stale") };
      return { error: t("approvals.notPending") };
    }
    // Domain checks inside a handler (e.g. a cancelled requirement) mean the request is out of date.
    if (err instanceof ServiceError || err instanceof BookingError || err instanceof BudgetError || err instanceof PaymentError || err instanceof QuoteError) {
      return { error: t("approvals.stale") };
    }
    throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  return {};
}

export async function withdrawAction(eventId: string, formData: FormData) {
  const ctx = await getEventContext(eventId);
  const requestId = String(formData.get("requestId"));
  if (!isUuid(requestId)) return;
  try {
    await withdrawRequest(getDb(), eventId, requestId, ctx.actor);
  } catch (err) {
    if (!(err instanceof ApprovalError)) throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
}
