import type { Task } from "@/db/schema";
import { Field, Input, Select, Textarea } from "./ui";

export type TaskFieldLabels = Record<
  "title" | "description" | "dueDate" | "assignee" | "function" | "none" | "priority" | "low" | "normal" | "high",
  string
>;

export function TaskFields({
  labels,
  task,
  members,
  functions,
  compact,
}: {
  labels: TaskFieldLabels;
  task?: Partial<Task>;
  members: { id: string; name: string | null }[];
  functions: { id: string; name: string }[];
  compact?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label={labels.title} htmlFor="title">
          <Input id="title" name="title" required maxLength={200} defaultValue={task?.title ?? ""} />
        </Field>
      </div>
      {!compact && (
        <div className="sm:col-span-2">
          <Field label={labels.description} htmlFor="description">
            <Textarea id="description" name="description" rows={3} maxLength={4000} defaultValue={task?.description ?? ""} />
          </Field>
        </div>
      )}
      <Field label={labels.dueDate} htmlFor="dueDate">
        <Input id="dueDate" name="dueDate" type="date" defaultValue={task?.dueDate ?? ""} />
      </Field>
      <Field label={labels.assignee} htmlFor="assigneeId">
        <Select id="assigneeId" name="assigneeId" defaultValue={task?.assigneeId ?? ""}>
          <option value="">{labels.none}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={labels.function} htmlFor="functionId">
        <Select id="functionId" name="functionId" defaultValue={task?.functionId ?? ""}>
          <option value="">{labels.none}</option>
          {functions.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={labels.priority} htmlFor="priority">
        <Select id="priority" name="priority" defaultValue={task?.priority ?? "normal"}>
          <option value="low">{labels.low}</option>
          <option value="normal">{labels.normal}</option>
          <option value="high">{labels.high}</option>
        </Select>
      </Field>
    </div>
  );
}
