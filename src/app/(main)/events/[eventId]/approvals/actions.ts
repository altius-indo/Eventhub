"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import "@/lib/approval-handlers";
import { ApprovalError, decideRequest, withdrawRequest } from "@/lib/approvals";
import { ForbiddenError } from "@/lib/policy";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

export async function decideAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const decision = formData.get("decision");
  if (decision !== "approve" && decision !== "reject" && decision !== "request_changes") return { error: t("common.somethingWrong") };
  try {
    await decideRequest(getDb(), {
      eventId,
      requestId: String(formData.get("requestId")),
      actor: ctx.actor,
      subject: ctx.subject,
      decision,
      comment: String(formData.get("comment") ?? ""),
    });
  } catch (err) {
    if (err instanceof ForbiddenError) return { error: t("common.notAllowed") };
    if (err instanceof ApprovalError) {
      if (err.code === "comment_required") return { error: t("approvals.commentRequired") };
      return { error: t("approvals.notPending") };
    }
    throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  return {};
}

export async function withdrawAction(eventId: string, formData: FormData) {
  const ctx = await getEventContext(eventId);
  try {
    await withdrawRequest(getDb(), eventId, String(formData.get("requestId")), ctx.actor);
  } catch (err) {
    if (!(err instanceof ApprovalError)) throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
}
