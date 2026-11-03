/**
 * Runs the daily jobs within one function invocation's time budget (ADR-0021, ADR-0033).
 *
 * Jobs run in the order given, so put time-critical ones (headcount locks, reminders, the outbox)
 * first and housekeeping (retention, storage) last. Each job is isolated: one that throws is
 * reported as "failed" and the rest still run. A job whose `minMs` no longer fits in the remaining
 * budget is "skipped" (it runs again tomorrow); jobs get the remaining budget as an argument so
 * they can stop early themselves.
 */

export type CronJob = {
  name: string;
  run: (remainingMs: number) => Promise<number>;
  /** Don't start unless at least this much time is left (default 1 s). */
  minMs?: number;
};

export type CronResult = Record<string, number | "failed" | "skipped">;

export async function runJobs(
  jobs: CronJob[],
  opts: { budgetMs: number; clock?: () => number; onError?: (name: string, err: unknown) => void },
): Promise<CronResult> {
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + opts.budgetMs;
  const result: CronResult = {};
  for (const job of jobs) {
    const remaining = deadline - clock();
    if (remaining < (job.minMs ?? 1000)) {
      result[job.name] = "skipped";
      continue;
    }
    try {
      result[job.name] = await job.run(remaining);
    } catch (err) {
      opts.onError?.(job.name, err);
      result[job.name] = "failed";
    }
  }
  return result;
}
