import { after, NextResponse } from "next/server";
import { getDb } from "@/db";
import { safeEqual } from "@/lib/crypto";
import { processOutbox } from "@/lib/outbox";

export const maxDuration = 60;

/**
 * Sends queued messages (ADR-0024). Bearer CRON_SECRET. If rows remain after the time budget,
 * it calls itself again after responding, so a large broadcast drains without a frequent cron.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const result = await processOutbox(getDb(), { budgetMs: 45_000 });
  if (result.remaining > 0) {
    const url = new URL(req.url);
    after(() => fetch(url, { method: "POST", headers: { authorization: auth } }).catch(() => undefined));
  }
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
