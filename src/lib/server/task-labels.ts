import "server-only";
import type { TaskFieldLabels } from "@/components/task-fields";
import type { Translator } from "@/i18n/core";

export function taskFieldLabels(t: Translator): TaskFieldLabels {
  return {
    title: t("tasks.form.title"),
    description: t("tasks.form.description"),
    dueDate: t("tasks.form.dueDate"),
    assignee: t("tasks.form.assignee"),
    function: t("tasks.form.function"),
    none: t("tasks.form.none"),
    priority: t("tasks.form.priority"),
    low: t("tasks.priority.low"),
    normal: t("tasks.priority.normal"),
    high: t("tasks.priority.high"),
  };
}
