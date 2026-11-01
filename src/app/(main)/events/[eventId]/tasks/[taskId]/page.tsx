import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { ConfirmButton } from "@/components/confirm-button";
import { SubmitButton } from "@/components/submit-button";
import { TaskFields } from "@/components/task-fields";
import { Card, CardTitle, Field, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { listMembers } from "@/lib/events";
import { listFunctions } from "@/lib/functions";
import { getTask, listComments, TaskError } from "@/lib/tasks";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { taskFieldLabels } from "@/lib/server/task-labels";
import { addCommentAction, deleteTaskAction, updateTaskAction } from "../actions";
import { isUuid } from "@/lib/ids";

export default async function TaskPage({ params }: PageProps<"/events/[eventId]/tasks/[taskId]">) {
  const { eventId, taskId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(taskId)) notFound();
  const db = getDb();
  const task = await getTask(db, eventId, taskId).catch((e) => {
    if (e instanceof TaskError) notFound();
    throw e;
  });
  const [comments, members, fns] = await Promise.all([listComments(db, taskId), listMembers(db, eventId), listFunctions(db, eventId)]);
  const { t, locale } = await getTranslator();
  const canEdit = ctx.can("tasks.edit");

  return (
    <div className="max-w-2xl space-y-4">
      <Link href={`/events/${eventId}/tasks`} className="text-sm text-primary hover:underline">
        ← {t("tasks.back")}
      </Link>
      <Card>
        <SimpleForm action={updateTaskAction.bind(null, eventId, taskId)} className="space-y-3">
          <fieldset disabled={!canEdit} className="space-y-3">
            <TaskFields labels={taskFieldLabels(t)} task={task} members={members.map((m) => ({ id: m.user.id, name: m.user.name }))} functions={fns} />
            <Field label={t("tasks.form.status")} htmlFor="status">
              <Select id="status" name="status" defaultValue={task.status} className="sm:w-1/2">
                <option value="todo">{t("tasks.status.todo")}</option>
                <option value="in_progress">{t("tasks.status.in_progress")}</option>
                <option value="done">{t("tasks.status.done")}</option>
              </Select>
            </Field>
          </fieldset>
          {canEdit && <SubmitButton>{t("common.save")}</SubmitButton>}
        </SimpleForm>
      </Card>

      <Card>
        <CardTitle>{t("tasks.comments")}</CardTitle>
        {comments.length === 0 ? (
          <p className="mb-3 text-sm text-muted">{t("tasks.noComments")}</p>
        ) : (
          <ol className="mb-4 space-y-3">
            {comments.map(({ comment, authorName }) => (
              <li key={comment.id} className="rounded-lg bg-surface-muted px-3 py-2">
                <p className="text-xs text-muted">
                  <span className="font-medium text-text">{authorName}</span> · {formatDateTime(locale, comment.createdAt)}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm">{comment.body}</p>
              </li>
            ))}
          </ol>
        )}
        <SimpleForm action={addCommentAction.bind(null, eventId, taskId)} className="space-y-2">
          <label htmlFor="body" className="sr-only">
            {t("tasks.addComment")}
          </label>
          <Textarea id="body" name="body" rows={2} maxLength={4000} required />
          <SubmitButton variant="secondary">{t("tasks.addComment")}</SubmitButton>
        </SimpleForm>
      </Card>

      {canEdit && (
        <form action={deleteTaskAction.bind(null, eventId, taskId)}>
          <ConfirmButton variant="ghost" className="text-danger" confirm={`${t("tasks.delete")}?`}>
            {t("tasks.delete")}
          </ConfirmButton>
        </form>
      )}
    </div>
  );
}
