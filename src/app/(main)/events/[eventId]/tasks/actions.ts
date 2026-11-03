"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { TaskStatus } from "@/db/schema";
import {
  addComment,
  applyDefaultChecklist,
  createTask,
  deleteTask,
  setTaskStatus,
  TaskError,
  taskSchema,
  todayIn,
  updateTask,
} from "@/lib/tasks";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };

async function editor(eventId: string) {
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  return { ctx, t, locale, allowed: ctx.can("tasks.edit") };
}

function parse(formData: FormData) {
  return taskSchema.safeParse({
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    dueDate: String(formData.get("dueDate") ?? ""),
    assigneeId: String(formData.get("assigneeId") ?? ""),
    functionId: String(formData.get("functionId") ?? ""),
    priority: String(formData.get("priority") ?? "normal"),
  });
}

export async function createTaskAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const { ctx, t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = parse(formData);
  if (!parsed.success) return { error: t("tasks.form.titleRequired") };
  try {
    await createTask(getDb(), eventId, ctx.actor, parsed.data);
  } catch (err) {
    if (err instanceof TaskError) return { error: t("common.somethingWrong") };
    throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  return { info: t("common.saved") };
}

export async function updateTaskAction(eventId: string, taskId: string, _prev: State, formData: FormData): Promise<State> {
  const { t, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const parsed = parse(formData);
  if (!parsed.success) return { error: t("tasks.form.titleRequired") };
  try {
    await updateTask(getDb(), eventId, taskId, parsed.data);
    const status = formData.get("status");
    if (status === "todo" || status === "in_progress" || status === "done") await setTaskStatus(getDb(), eventId, taskId, status);
  } catch (err) {
    if (err instanceof TaskError) return { error: t("common.somethingWrong") };
    throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  return { info: t("common.saved") };
}

export async function setStatusAction(eventId: string, taskId: string, status: TaskStatus) {
  const { allowed } = await editor(eventId);
  if (!allowed) return;
  try {
    await setTaskStatus(getDb(), eventId, taskId, status);
  } catch (err) {
    if (!(err instanceof TaskError)) throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
}

export async function deleteTaskAction(eventId: string, taskId: string) {
  const { ctx, allowed } = await editor(eventId);
  if (!allowed) return;
  try {
    await deleteTask(getDb(), eventId, taskId, ctx.actor);
  } catch (err) {
    if (!(err instanceof TaskError)) throw err;
  }
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/tasks`);
}

export async function addCommentAction(eventId: string, taskId: string, _prev: State, formData: FormData): Promise<State> {
  const { ctx, t } = await editor(eventId);
  // Anyone on the team can comment, including people without edit rights.
  const body = String(formData.get("body") ?? "");
  if (!body.trim()) return {};
  try {
    await addComment(getDb(), eventId, taskId, ctx.user.id, body);
  } catch (err) {
    if (err instanceof TaskError) return { error: t("common.somethingWrong") };
    throw err;
  }
  revalidatePath(`/events/${eventId}/tasks/${taskId}`);
  return { info: t("common.saved") };
}

export async function applyChecklistAction(eventId: string, _prev: State): Promise<State> {
  const { ctx, t, locale, allowed } = await editor(eventId);
  if (!allowed) return { error: t("common.notAllowed") };
  const count = await applyDefaultChecklist(getDb(), eventId, ctx.actor, locale, todayIn(ctx.event.timezone));
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/tasks?added=${count}`);
}
