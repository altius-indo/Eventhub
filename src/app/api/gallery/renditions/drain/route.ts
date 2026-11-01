import { after, NextResponse } from "next/server";
import { getDb } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { processRenditions } from "@/lib/renditions";
import { getStore } from "@/lib/storage";

export const maxDuration = 60;

/**
 * Makes gallery renditions (ADR-0032). Bearer CRON_SECRET. While items remain after the time
 * budget it calls itself again after responding, so a 2,000-photo delivery finishes without a
 * frequent cron (same pattern as /api/outbox/drain).
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await processRenditions(getDb(), getStore(), { budgetMs: 45_000 });
  if (result.remaining > 0 && result.processed > 0) {
    const url = new URL(req.url);
    after(() => fetch(url, { method: "POST", headers: { authorization: auth } }).then(
      () => undefined,
      () => undefined,
    ));
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
