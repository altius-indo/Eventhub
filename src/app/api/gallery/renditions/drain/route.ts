import { after, NextResponse } from "next/server";
import { getDb } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { nextRenditionsDelay, processRenditions } from "@/lib/renditions";
import { getStore } from "@/lib/storage";
import "@/lib/templates";
import { resolveAppUrl } from "@/lib/app-url";

export const maxDuration = 60;
/** Keep the follow-up wait inside this invocation's maxDuration (with a margin). */
const MAX_WAIT_MS = 50_000;

/**
 * Makes gallery renditions (ADR-0032), one photo at a time. Bearer CRON_SECRET. While items remain
 * after the time budget it calls itself again after responding, and when a retry (after a
 * temporary failure) falls due within a couple of minutes it waits for it and then calls itself,
 * so a 2,000-photo delivery or a storage hiccup doesn't wait for the daily cron (same pattern as
 * /api/outbox/drain).
 */
export async function POST(req: Request) {
  const started = Date.now();
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const appUrl = resolveAppUrl();
  const result = await processRenditions(getDb(), getStore(), { budgetMs: 40_000, appUrl });
  const delay = nextRenditionsDelay(result, new Date());
  if (delay != null) {
    const wait = Math.max(0, Math.min(delay, MAX_WAIT_MS - (Date.now() - started)));
    after(async () => {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await fetch(url, { method: "POST", headers: { authorization: auth } }).catch(() => undefined);
    });
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
