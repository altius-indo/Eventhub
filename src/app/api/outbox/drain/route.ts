import { after, NextResponse } from "next/server";
import { getDb } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { nextDrainDelay, processOutbox } from "@/lib/outbox";
import "@/lib/templates";

export const maxDuration = 60;
/** Keep the follow-up wait inside this invocation's maxDuration (with a margin). */
const MAX_WAIT_MS = 50_000;

/**
 * Sends queued messages (ADR-0024). Bearer CRON_SECRET. If rows remain after the time budget,
 * it calls itself again after responding, so a large broadcast drains without a frequent cron.
 * When a retry falls due within a couple of minutes, it waits (capped to fit maxDuration) and then
 * calls itself, so short backoffs don't wait for the daily cron.
 */
export async function POST(req: Request) {
  const started = Date.now();
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await processOutbox(getDb(), { budgetMs: 45_000 });
  const delay = nextDrainDelay(result, new Date());
  if (delay != null) {
    const url = new URL(req.url);
    const wait = Math.max(0, Math.min(delay, MAX_WAIT_MS - (Date.now() - started)));
    after(async () => {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await fetch(url, { method: "POST", headers: { authorization: auth } }).catch(() => undefined);
    });
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
