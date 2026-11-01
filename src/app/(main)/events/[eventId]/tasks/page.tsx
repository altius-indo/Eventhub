import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { TaskFields } from "@/components/task-fields";
import { Alert, Badge, Card, CardTitle, PageHeader, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { listMembers } from "@/lib/events";
import { listFunctions } from "@/lib/functions";
import { bucketOf, listTasks, todayIn, type TaskBucket, type TaskFilters } from "@/lib/tasks";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { taskFieldLabels } from "@/lib/server/task-labels";
import { applyChecklistAction, createTaskAction, setStatusAction } from "./actions";
import { isUuid } from "@/lib/ids";

const bucketOrder: TaskBucket[] = ["overdue", "thisWeek", "later", "noDate", "done"];
const bucketTone = { overdue: "danger", thisWeek: "warning", later: "neutral", noDate: "neutral", done: "success" } as const;

export default async function TasksPage({ params, searchParams }: PageProps<"/events/[eventId]/tasks">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const status = sp.status === "done" || sp.status === "all" ? sp.status : "open";
  const assignee = typeof sp.assignee === "string" ? (sp.assignee === "me" ? ctx.user.id : sp.assignee) : undefined;
  const fn = typeof sp.fn === "string" && isUuid(sp.fn) ? sp.fn : undefined;
  const filters: TaskFilters = { status, assignee: assignee && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|none)$/i.test(assignee) ? assignee : undefined, fn };
  const [rows, members, fns, anyTasks] = await Promise.all([
    listTasks(db, eventId, filters),
    listMembers(db, eventId),
    listFunctions(db, eventId),
    listTasks(db, eventId, { status: "all" }).then((r) => r.length),
  ]);
  const today = todayIn(ctx.event.timezone);
  const canEdit = ctx.can("tasks.edit");
  const base = `/events/${eventId}/tasks`;
  const grouped = new Map<TaskBucket, typeof rows>();
  for (const r of rows) {
    const b = bucketOf(r.task, today);
    grouped.set(b, [...(grouped.get(b) ?? []), r]);
  }
  const memberOptions = members.map((m) => ({ id: m.user.id, name: m.user.name }));

  return (
    <div className="space-y-4">
      <PageHeader title={t("tasks.title")} />
      {typeof sp.added === "string" && /^\d+$/.test(sp.added) && <Alert tone="success">{t("tasks.templateAdded", { count: sp.added })}</Alert>}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card>
            <form className="flex flex-wrap gap-2" role="search">
              <Select name="status" defaultValue={status} className="w-auto" aria-label={t("tasks.form.status")}>
                <option value="open">{t("tasks.open")}</option>
                <option value="done">{t("tasks.done")}</option>
                <option value="all">{t("tasks.all")}</option>
              </Select>
              <Select name="assignee" defaultValue={typeof sp.assignee === "string" ? sp.assignee : ""} className="w-auto" aria-label={t("tasks.form.assignee")}>
                <option value="">{t("tasks.anyone")}</option>
                <option value="me">{t("tasks.mine")}</option>
                <option value="none">{t("tasks.unassigned")}</option>
                {memberOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
              {fns.length > 0 && (
                <Select name="fn" defaultValue={fn ?? ""} className="w-auto" aria-label={t("tasks.form.function")}>
                  <option value="">{t("tasks.anyFunction")}</option>
                  {fns.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              )}
              <button type="submit" className={buttonClass("secondary")}>
                {t("guests.filter")}
              </button>
            </form>
          </Card>

          {rows.length === 0 ? (
            <Card>
              <p className="text-muted">{t("tasks.empty")}</p>
            </Card>
          ) : (
            bucketOrder
              .filter((b) => grouped.has(b))
              .map((b) => (
                <section key={b}>
                  <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <Badge tone={bucketTone[b]}>{t(`tasks.buckets.${b}`)}</Badge>
                    <span className="text-muted">{grouped.get(b)!.length}</span>
                  </h2>
                  <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                    {grouped.get(b)!.map(({ task, assigneeName, functionName, comments }) => {
                      const done = task.status === "done";
                      return (
                        <li key={task.id} className="flex items-start gap-3 px-3 py-2.5">
                          {canEdit ? (
                            <form action={setStatusAction.bind(null, eventId, task.id, done ? "todo" : "done")}>
                              <button
                                type="submit"
                                aria-label={done ? t("tasks.reopen") : t("tasks.markDone")}
                                className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface-muted`}
                              >
                                <span
                                  aria-hidden
                                  className={`flex h-5 w-5 items-center justify-center rounded border-2 text-xs ${done ? "border-success bg-success text-white" : "border-border"}`}
                                >
                                  {done ? "✓" : ""}
                                </span>
                              </button>
                            </form>
                          ) : (
                            <span className="h-11 w-11" />
                          )}
                          <Link href={`${base}/${task.id}`} className="min-w-0 flex-1 py-2 hover:text-primary">
                            <p className={done ? "text-muted line-through" : ""}>
                              {task.title}{" "}
                              {task.priority === "high" && !done && <Badge tone="danger">{t("tasks.priority.high")}</Badge>}
                              {task.status === "in_progress" && <Badge tone="primary">{t("tasks.status.in_progress")}</Badge>}
                            </p>
                            <p className="text-sm text-muted">
                              {[
                                task.dueDate && t("tasks.due", { date: formatDay(locale, task.dueDate) }),
                                assigneeName,
                                functionName,
                                comments > 0 && t("tasks.commentsCount", { count: comments }),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
          )}
        </div>

        {canEdit && (
          <div className="space-y-4">
            <Card>
              <CardTitle>{t("tasks.add")}</CardTitle>
              <SimpleForm action={createTaskAction.bind(null, eventId)} className="space-y-3">
                <TaskFields labels={taskFieldLabels(t)} members={memberOptions} functions={fns} compact />
                <SubmitButton className="w-full">{t("tasks.add")}</SubmitButton>
              </SimpleForm>
            </Card>
            {anyTasks < 5 && (
              <Card>
                <SimpleForm action={applyChecklistAction.bind(null, eventId)} className="space-y-2">
                  <SubmitButton variant="secondary" className="w-full">
                    {t("tasks.applyTemplate")}
                  </SubmitButton>
                </SimpleForm>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
