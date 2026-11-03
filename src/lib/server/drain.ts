import "server-only";
import { after } from "next/server";
import { getDb } from "@/db";
import { nextDrainDelay, processOutbox } from "../outbox";
import "../templates";
import { appUrl } from "./session";

/**
 * After the response is sent, deliver what this request queued (ADR-0024). Big batches, and
 * retries due within a couple of minutes, hand over to /api/outbox/drain, which keeps calling
 * itself (waiting for near retries) until nothing is due soon.
 */
export function drainSoon() {
  after(async () => {
    const res = await processOutbox(getDb(), { budgetMs: 20_000 });
    const secret = process.env.CRON_SECRET;
    if (nextDrainDelay(res, new Date()) != null && secret) {
      await fetch(`${appUrl()}/api/outbox/drain`, { method: "POST", headers: { authorization: `Bearer ${secret}` } }).catch(() => undefined);
    }
  });
}
