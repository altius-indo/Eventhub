import { describe, expect, it } from "vitest";
import { runJobs } from "@/lib/cron";

describe("daily cron runner (ADR-0021)", () => {
  it("runs jobs in order, isolates failures and skips what no longer fits the budget", async () => {
    let t = 0;
    const clock = () => t;
    const ran: string[] = [];
    const errors: string[] = [];
    const result = await runJobs(
      [
        { name: "locks", run: async () => (ran.push("locks"), (t += 5_000), 3) },
        { name: "broken", run: async () => (ran.push("broken"), Promise.reject(new Error("boom"))) },
        { name: "reminders", run: async (left) => (ran.push(`reminders:${left}`), (t += 30_000), 2) },
        { name: "purge", run: async () => (ran.push("purge"), 1), minMs: 20_000 },
        { name: "small", run: async (left) => (ran.push(`small:${left}`), 0) },
      ],
      { budgetMs: 50_000, clock, onError: (name) => errors.push(name) },
    );
    expect(result).toEqual({ locks: 3, broken: "failed", reminders: 2, purge: "skipped", small: 0 });
    expect(ran).toEqual(["locks", "broken", "reminders:45000", "small:15000"]);
    expect(errors).toEqual(["broken"]);
  });
});
