import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { tasks } from "@/db/schema";
import { createEvent, inviteMember } from "@/lib/events";
import {
  addComment,
  applyDefaultChecklist,
  bucketOf,
  createTask,
  defaultChecklist,
  listComments,
  listTasks,
  sendTaskReminders,
  setTaskStatus,
  taskSchema,
  TaskError,
  taskSummary,
} from "@/lib/tasks";
import { actorOf, db, makeUser, outbox, resetDb } from "./helpers";

beforeEach(resetDb);

async function setup(startDate = "2026-12-10") {
  const host = await makeUser("host@example.com", "Asha");
  const event = await createEvent(db(), actorOf(host), { name: "Wedding", startDate });
  return { host, event };
}
const input = (v: Record<string, unknown>) => taskSchema.parse(v);

describe("tasks", () => {
  it("buckets by due date", () => {
    const today = "2026-11-01";
    expect(bucketOf({ status: "todo", dueDate: "2026-10-31" }, today)).toBe("overdue");
    expect(bucketOf({ status: "todo", dueDate: "2026-11-01" }, today)).toBe("thisWeek");
    expect(bucketOf({ status: "todo", dueDate: "2026-11-08" }, today)).toBe("thisWeek");
    expect(bucketOf({ status: "todo", dueDate: "2026-11-09" }, today)).toBe("later");
    expect(bucketOf({ status: "todo", dueDate: null }, today)).toBe("noDate");
    expect(bucketOf({ status: "done", dueDate: "2026-10-01" }, today)).toBe("done");
  });

  it("only assigns to team members and tracks completion and comments", async () => {
    const { host, event } = await setup();
    const stranger = await makeUser("x@example.com");
    await expect(createTask(db(), event.id, actorOf(host), input({ title: "Book DJ", assigneeId: stranger.id }))).rejects.toBeInstanceOf(TaskError);

    const task = await createTask(db(), event.id, actorOf(host), input({ title: "Book DJ", assigneeId: host.id, dueDate: "2026-10-30", priority: "high" }));
    await addComment(db(), event.id, task.id, host.id, "Called two DJs");
    expect((await listComments(db(), task.id)).map((c) => c.comment.body)).toEqual(["Called two DJs"]);
    expect(await taskSummary(db(), event.id, "2026-11-01")).toEqual({ open: 1, overdue: 1, dueThisWeek: 0, done: 0 });

    const done = await setTaskStatus(db(), event.id, task.id, "done");
    expect(done.completedAt).not.toBeNull();
    expect(await listTasks(db(), event.id)).toHaveLength(0);
    expect(await listTasks(db(), event.id, { status: "done" })).toHaveLength(1);
    expect((await setTaskStatus(db(), event.id, task.id, "todo")).completedAt).toBeNull();
  });

  it("adds the default checklist once, with dates counted back from the event", async () => {
    const { host, event } = await setup("2027-06-01");
    const n = await applyDefaultChecklist(db(), event.id, actorOf(host), "en", "2026-11-01");
    expect(n).toBe(defaultChecklist.length);
    const rows = await db().select().from(tasks).where(eq(tasks.eventId, event.id));
    const invites = rows.find((r) => r.title === "Send invitations");
    expect(invites?.dueDate).toBe("2027-03-18"); // 75 days before
    // Past dates are clamped to today
    expect(rows.find((r) => r.title.startsWith("Agree the overall budget"))?.dueDate).toBe("2026-11-01");
    expect(await applyDefaultChecklist(db(), event.id, actorOf(host), "en", "2026-11-01")).toBe(0);
    // Hindi titles are added as separate tasks only if not already present
    expect(await applyDefaultChecklist(db(), event.id, actorOf(host), "hi", "2026-11-01")).toBe(defaultChecklist.length);
  });

  it("sends one daily reminder per assignee for tasks due by tomorrow", async () => {
    const { host, event } = await setup();
    const planner = await makeUser("+919876543210", "Ravi");
    await inviteMember(db(), {
      event, actor: actorOf(host), inviterName: "Asha", identifier: { type: "phone", value: "+919876543210" }, role: "planner", locale: "en", appUrl: "x",
    });
    const now = new Date("2026-11-01T04:00:00Z"); // 09:30 in India
    await createTask(db(), event.id, actorOf(host), input({ title: "Overdue thing", assigneeId: host.id, dueDate: "2026-10-30" }));
    await createTask(db(), event.id, actorOf(host), input({ title: "Tomorrow thing", assigneeId: host.id, dueDate: "2026-11-02" }));
    await createTask(db(), event.id, actorOf(host), input({ title: "Next week", assigneeId: host.id, dueDate: "2026-11-08" }));
    await createTask(db(), event.id, actorOf(host), input({ title: "Planner task", assigneeId: planner.id, dueDate: "2026-11-01" }));
    await createTask(db(), event.id, actorOf(host), input({ title: "Nobody's", dueDate: "2026-11-01" }));

    const before = (await outbox()).length;
    expect(await sendTaskReminders(db(), now, "http://app")).toBe(2);
    const msgs = (await outbox()).slice(before);
    const hostMsg = msgs.find((m) => m.to === "host@example.com")!;
    expect(hostMsg.body).toContain("Overdue thing");
    expect(hostMsg.body).toContain("Tomorrow thing");
    expect(hostMsg.body).not.toContain("Next week");
    expect(msgs.find((m) => m.to === "+919876543210")?.channel).toBe("sms");

    // Not again the same day, but again the next day
    expect(await sendTaskReminders(db(), new Date("2026-11-01T12:00:00Z"))).toBe(0);
    expect(await sendTaskReminders(db(), new Date("2026-11-02T04:00:00Z"))).toBe(2);
  });
});
