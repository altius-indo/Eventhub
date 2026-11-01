import "server-only";
import { after } from "next/server";
import { getDb } from "@/db";
import { processOutbox } from "../outbox";
import { appUrl } from "./session";

/**
 * After the response is sent, deliver what this request queued (ADR-0024). Big batches hand
 * over to /api/outbox/drain, which keeps calling itself until the queue is empty.
 */
export function drainSoon() {
  after(async () => {
    const res = await processOutbox(getDb(), { budgetMs: 20_000 });
    const secret = process.env.CRON_SECRET;
    if (res.remaining > 0 && secret) {
      await fetch(`${appUrl()}/api/outbox/drain`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).catch(() => undefined);
    }
  });
}
