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
  taskCounts,
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

  it("searches and filters tasks, and counts per status for the tabs (ITN-05)", async () => {
    const { host, event } = await setup();
    const a = actorOf(host);
    const today = "2026-11-01";
    const dj = await createTask(db(), event.id, a, input({ title: "Book DJ", description: "Sangeet night", dueDate: "2026-10-30", priority: "high" }));
    await createTask(db(), event.id, a, input({ title: "Order flowers", dueDate: "2026-11-05", assigneeId: host.id }));
    await createTask(db(), event.id, a, input({ title: "Print menus 100%_done", dueDate: "2026-12-01" }));
    await setTaskStatus(db(), event.id, dj.id, "done");
    const titles = async (f: Parameters<typeof listTasks>[2]) => (await listTasks(db(), event.id, { today, ...f })).map((r) => r.task.title).sort();

    expect(await titles({ status: "all", q: "sangeet" })).toEqual(["Book DJ"]); // description matches
    expect(await titles({ status: "all", q: "book  dj" })).toEqual(["Book DJ"]); // every word must match
    expect(await titles({ status: "all", q: "%" })).toEqual(["Print menus 100%_done"]); // LIKE wildcards are literal
    expect(await titles({ status: "all", due: "overdue" })).toEqual(["Book DJ"]);
    expect(await titles({ status: "open", due: "week" })).toEqual(["Order flowers"]);
    expect(await titles({ status: "all", highOnly: true })).toEqual(["Book DJ"]);
    expect(await titles({ status: "open", assignee: "none" })).toEqual(["Print menus 100%_done"]);

    expect(await taskCounts(db(), event.id)).toEqual({ open: 2, done: 1, all: 3 });
    expect(await taskCounts(db(), event.id, { q: "o" })).toEqual({ open: 2, done: 1, all: 3 });
    expect(await taskCounts(db(), event.id, { q: "flowers" })).toEqual({ open: 1, done: 0, all: 1 });
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
