import { and, asc, desc, eq, inArray, isNotNull, lte, ne, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  eventMembers,
  events,
  functions,
  taskComments,
  taskPriority,
  tasks,
  taskStatus,
  userIdentifiers,
  users,
  type Task,
  type TaskStatus,
} from "@/db/schema";
import { createTranslator, isLocale, type MessageKey } from "@/i18n/core";
import { audit, type Actor } from "./audit";
import { linkBase } from "./app-url";
import { DeliveryError, sendMessage } from "./delivery";

export class TaskError extends Error {
  constructor(public code: "not_found" | "bad_assignee" | "bad_function") {
    super(code);
  }
}

export const taskSchema = z.object({
  title: z.string().trim().min(1, "titleRequired").max(200),
  description: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .transform((v) => v || null),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  assigneeId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  functionId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(""))
    .transform((v) => v || null),
  priority: z.enum(taskPriority.enumValues).default("normal"),
});
export type TaskInput = z.infer<typeof taskSchema>;

/** Assignees must be team members; linked functions must belong to the event. */
async function validateRefs(tx: Tx, eventId: string, input: TaskInput) {
  if (input.assigneeId) {
    const [m] = await tx
      .select({ id: eventMembers.id })
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, eventId), eq(eventMembers.userId, input.assigneeId)));
    if (!m) throw new TaskError("bad_assignee");
  }
  if (input.functionId) {
    const [f] = await tx
      .select({ id: functions.id })
      .from(functions)
      .where(and(eq(functions.eventId, eventId), eq(functions.id, input.functionId)));
    if (!f) throw new TaskError("bad_function");
  }
}

export async function createTask(db: Database, eventId: string, actor: Actor, input: TaskInput) {
  return db.transaction(async (tx) => {
    await validateRefs(tx, eventId, input);
    const [task] = await tx.insert(tasks).values({ eventId, ...input, createdBy: actor.userId }).returning();
    return task;
  });
}

export async function updateTask(db: Database, eventId: string, taskId: string, input: TaskInput) {
  return db.transaction(async (tx) => {
    await validateRefs(tx, eventId, input);
    const [task] = await tx
      .update(tasks)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(tasks.id, taskId), eq(tasks.eventId, eventId)))
      .returning();
    if (!task) throw new TaskError("not_found");
    return task;
  });
}

export async function setTaskStatus(db: Database, eventId: string, taskId: string, status: TaskStatus) {
  const [task] = await db
    .update(tasks)
    .set({ status, completedAt: status === "done" ? new Date() : null, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.eventId, eventId)))
    .returning();
  if (!task) throw new TaskError("not_found");
  return task;
}

export async function deleteTask(db: Database, eventId: string, taskId: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const [task] = await tx
      .delete(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.eventId, eventId)))
      .returning();
    if (!task) throw new TaskError("not_found");
    await audit(tx, { eventId, actor, action: "task.deleted", entityType: "task", entityId: taskId, data: { title: task.title } });
  });
}

export async function getTask(db: Tx, eventId: string, taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.eventId, eventId)));
  if (!task) throw new TaskError("not_found");
  return task;
}

export async function addComment(db: Database, eventId: string, taskId: string, authorId: string, body: string) {
  const text = body.trim().slice(0, 4000);
  if (!text) return null;
  await getTask(db, eventId, taskId);
  const [comment] = await db.insert(taskComments).values({ taskId, authorId, body: text }).returning();
  return comment;
}

export async function listComments(db: Tx, taskId: string) {
  return db
    .select({ comment: taskComments, authorName: users.name })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));
}

export type TaskFilters = {
  status?: "open" | "done" | "all";
  assignee?: string;
  fn?: string;
  /** Words to find in the title or description (case-insensitive). */
  q?: string;
  /** Overdue, or due within the next 7 days (incl. overdue), relative to `today`. */
  due?: "overdue" | "week";
  /** YYYY-MM-DD in the event timezone; needed for `due`. */
  today?: string;
  highOnly?: boolean;
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Conditions shared by the list and the tab counts (everything except status). */
function taskConditions(eventId: string, f: TaskFilters) {
  const words = (f.q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return [
    eq(tasks.eventId, eventId),
    f.assignee === "none" ? isNull(tasks.assigneeId) : f.assignee ? eq(tasks.assigneeId, f.assignee) : undefined,
    f.fn ? eq(tasks.functionId, f.fn) : undefined,
    ...words.map((w) => {
      const p = `%${escapeLike(w)}%`;
      return sql`(${tasks.title} ilike ${p} or coalesce(${tasks.description}, '') ilike ${p})`;
    }),
    f.due && f.today ? isNotNull(tasks.dueDate) : undefined,
    f.due === "overdue" && f.today ? sql`${tasks.dueDate} < ${f.today}` : undefined,
    f.due === "week" && f.today ? lte(tasks.dueDate, addDays(f.today, 7)) : undefined,
    f.highOnly ? eq(tasks.priority, "high") : undefined,
  ];
}

/** Counts per status tab for the current (non-status) filters. */
export async function taskCounts(db: Tx, eventId: string, f: TaskFilters = {}) {
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${tasks.status} <> 'done')::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(and(...taskConditions(eventId, f)));
  return row ?? { open: 0, done: 0, all: 0 };
}

export async function listTasks(db: Tx, eventId: string, f: TaskFilters = {}) {
  const status = f.status ?? "open";
  return db
    .select({
      task: tasks,
      assigneeName: users.name,
      functionName: functions.name,
      comments: sql<number>`(select count(*)::int from ${taskComments} where ${taskComments.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .leftJoin(functions, eq(functions.id, tasks.functionId))
    .where(
      and(
        ...taskConditions(eventId, f),
        status === "open" ? ne(tasks.status, "done") : status === "done" ? eq(tasks.status, "done") : undefined,
      ),
    )
    .orderBy(
      status === "done" ? desc(tasks.completedAt) : sql`${tasks.dueDate} asc nulls last`,
      sql`case ${tasks.priority} when 'high' then 0 when 'normal' then 1 else 2 end`,
      asc(tasks.createdAt),
    );
}

export type TaskBucket = "overdue" | "thisWeek" | "later" | "noDate" | "done";

/** Groups tasks for the checklist view relative to `today` (YYYY-MM-DD in the event timezone). */
export function bucketOf(task: Pick<Task, "status" | "dueDate">, today: string): TaskBucket {
  if (task.status === "done") return "done";
  if (!task.dueDate) return "noDate";
  if (task.dueDate < today) return "overdue";
  const weekAhead = addDays(today, 7);
  return task.dueDate <= weekAhead ? "thisWeek" : "later";
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

export async function taskSummary(db: Tx, eventId: string, today: string) {
  const [row] = await db
    .select({
      open: sql<number>`count(*) filter (where ${tasks.status} <> 'done')::int`,
      overdue: sql<number>`count(*) filter (where ${tasks.status} <> 'done' and ${tasks.dueDate} < ${today})::int`,
      dueThisWeek: sql<number>`count(*) filter (where ${tasks.status} <> 'done' and ${tasks.dueDate} between ${today} and ${addDays(today, 7)})::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
    })
    .from(tasks)
    .where(eq(tasks.eventId, eventId));
  return row;
}

// ---------------------------------------------------------------------------
// Default wedding checklist (ITN-05)
// ---------------------------------------------------------------------------

/** Template tasks with due dates relative to the event's start date (days before). */
export const defaultChecklist: { key: MessageKey; daysBefore: number; priority?: "high" | "normal" | "low" }[] = [
  { key: "checklist.budget", daysBefore: 240, priority: "high" },
  { key: "checklist.guestList", daysBefore: 210, priority: "high" },
  { key: "checklist.venue", daysBefore: 180, priority: "high" },
  { key: "checklist.functions", daysBefore: 170 },
  { key: "checklist.caterer", daysBefore: 150, priority: "high" },
  { key: "checklist.decor", daysBefore: 140 },
  { key: "checklist.photographer", daysBefore: 140 },
  { key: "checklist.hotelBlock", daysBefore: 120, priority: "high" },
  { key: "checklist.pandit", daysBefore: 120 },
  { key: "checklist.outfits", daysBefore: 110 },
  { key: "checklist.music", daysBefore: 100 },
  { key: "checklist.makeup", daysBefore: 90 },
  { key: "checklist.invites", daysBefore: 75, priority: "high" },
  { key: "checklist.transport", daysBefore: 60 },
  { key: "checklist.travelDetails", daysBefore: 45 },
  { key: "checklist.rsvpFollowUp", daysBefore: 30 },
  { key: "checklist.roomAllocation", daysBefore: 21 },
  { key: "checklist.seating", daysBefore: 14 },
  { key: "checklist.finalHeadcount", daysBefore: 7, priority: "high" },
  { key: "checklist.runSheet", daysBefore: 7 },
  { key: "checklist.payments", daysBefore: 3, priority: "high" },
  { key: "checklist.emergencyKit", daysBefore: 2 },
];

/**
 * Adds the default checklist, skipping titles that already exist. Due dates
 * count back from the event start; past dates are clamped to `today`.
 */
export async function applyDefaultChecklist(db: Database, eventId: string, actor: Actor, locale: string, today: string) {
  const t = createTranslator(isLocale(locale) ? locale : "en");
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId));
    const existing = new Set(
      (await tx.select({ title: tasks.title }).from(tasks).where(eq(tasks.eventId, eventId))).map((r) => r.title.toLowerCase()),
    );
    const rows = defaultChecklist
      .map((item) => {
        const title = t(item.key);
        const due = event.startDate ? addDays(event.startDate, -item.daysBefore) : null;
        return {
          eventId,
          title,
          dueDate: due && due < today ? today : due,
          priority: item.priority ?? ("normal" as const),
          createdBy: actor.userId,
        };
      })
      .filter((r) => !existing.has(r.title.toLowerCase()));
    if (rows.length) await tx.insert(tasks).values(rows);
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// Reminders (run daily by `npm run jobs:reminders`)
// ---------------------------------------------------------------------------

/**
 * Sends each assignee one message listing their open tasks that are overdue
 * or due tomorrow, at most once per day per task.
 */
export async function sendTaskReminders(db: Database, now = new Date(), appUrl?: string) {
  const base = linkBase(appUrl);
  const rows = await db
    .select({ task: tasks, event: events, user: users })
    .from(tasks)
    .innerJoin(events, eq(events.id, tasks.eventId))
    .innerJoin(users, eq(users.id, tasks.assigneeId))
    .where(
      and(
        ne(tasks.status, "done"),
        isNotNull(tasks.dueDate),
        isNull(events.deletedAt),
        isNull(users.suspendedAt),
        // due tomorrow or earlier, in the event's timezone
        lte(tasks.dueDate, sql`((${now.toISOString()}::timestamptz at time zone ${events.timezone})::date + 1)`),
        or(isNull(tasks.lastRemindedOn), sql`${tasks.lastRemindedOn} < (${now.toISOString()}::timestamptz at time zone ${events.timezone})::date`),
      ),
    )
    .orderBy(asc(tasks.dueDate));

  const byUser = new Map<string, typeof rows>();
  for (const r of rows) byUser.set(r.user.id, [...(byUser.get(r.user.id) ?? []), r]);

  let sent = 0;
  for (const [userId, items] of byUser) {
    const ids = await db.select().from(userIdentifiers).where(eq(userIdentifiers.userId, userId));
    const target = ids.find((i) => i.type === "email") ?? ids.find((i) => i.type === "phone");
    if (!target) continue;
    const user = items[0].user;
    const t = createTranslator(isLocale(user.locale) ? user.locale : "en");
    const lines = items.map(({ task, event }) => `• ${task.title} (${event.name}, ${task.dueDate})`);
    try {
      await sendMessage(db, {
        channel: target.type === "email" ? "email" : "sms",
        to: target.value,
        subject: t("tasks.reminderSubject"),
        text: `${t("tasks.reminderIntro")}\n${lines.join("\n")}\n${base}/events`,
      });
    } catch (err) {
      if (err instanceof DeliveryError) {
        console.error("Task reminder failed", err);
        continue;
      }
      throw err;
    }
    for (const { task, event } of items) {
      await db
        .update(tasks)
        .set({ lastRemindedOn: todayIn(event.timezone, now) })
        .where(inArray(tasks.id, [task.id]));
    }
    sent++;
  }
  return sent;
}

export { taskStatus };
