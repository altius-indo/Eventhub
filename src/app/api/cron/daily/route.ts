import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { checkHeadcountAlerts, freezeAllDueLocks } from "@/lib/caterer-headcount";
import { safeEqual } from "@/lib/crypto";
import { purgeDeletedEvents } from "@/lib/events";
import { purgeOldNotifications } from "@/lib/notifications";
import { processOutbox } from "@/lib/outbox";
import { sendApprovalReminders, sendPaymentReminders } from "@/lib/payments";
import { sendRsvpReminders } from "@/lib/rsvp";
import { sendTaskReminders } from "@/lib/tasks";

/** Long enough for a day's reminders across events. */
export const maxDuration = 60;

/**
 * The daily jobs (ADR-0021), for schedulers that call a URL (Vercel Cron, see vercel.json).
 * Same work as the `npm run jobs:*` scripts. Requires `Authorization: Bearer <CRON_SECRET>`,
 * which Vercel Cron sends automatically when CRON_SECRET is set.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || secret.length < 16 || !safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = getDb();
  const now = new Date();
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const jobs: [string, () => Promise<number>][] = [
    ["purge", () => purgeDeletedEvents(db, now)],
    ["taskReminders", () => sendTaskReminders(db, now, appUrl)],
    ["rsvpReminders", () => sendRsvpReminders(db, appUrl, now)],
    ["paymentReminders", () => sendPaymentReminders(db, now, appUrl)],
    ["approvalReminders", () => sendApprovalReminders(db, now, appUrl)],
    ["outbox", async () => (await processOutbox(db, { budgetMs: 20_000 })).processed],
    ["oldNotifications", () => purgeOldNotifications(db, now)],
    // [vendor-portal daily jobs]
    ["headcountLocks", () => freezeAllDueLocks(db, now)],
    ["headcountAlerts", () => checkHeadcountAlerts(db, now)],
    // [gifts daily jobs]
  ];
  const result: Record<string, number | string> = {};
  // One failing job must not stop the others.
  for (const [name, run] of jobs) {
    try {
      result[name] = await run();
    } catch (err) {
      console.error(`cron ${name} failed`, err);
      result[name] = "failed";
    }
  }
  const failed = Object.values(result).includes("failed");
  return NextResponse.json(result, { status: failed ? 500 : 200, headers: { "Cache-Control": "no-store" } });
}
