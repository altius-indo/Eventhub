import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { checkHeadcountAlerts, freezeAllDueLocks } from "@/lib/caterer-headcount";
import { runJobs, type CronJob } from "@/lib/cron";
import { safeEqual } from "@/lib/crypto";
import { purgeDeletedEvents } from "@/lib/events";
import { purgeOldNotifications } from "@/lib/notifications";
import { processOutbox } from "@/lib/outbox";
import "@/lib/templates";
import { sendApprovalReminders, sendPaymentReminders } from "@/lib/payments";
import { sendRsvpReminders } from "@/lib/rsvp";
import { sendTaskReminders } from "@/lib/tasks";
import { sendThankYouReminders } from "@/lib/thank-yous";
import { purgeExpiredEvents, sendRetentionReminders } from "@/lib/retention";
import { getStore } from "@/lib/storage";
import { processStorageDeletions, reconcileStorage } from "@/lib/storage-gc";
import { releaseExpiredReservations } from "@/lib/storage-quota";
import { sweepOrphanObjects, sweepUploads } from "@/lib/gallery";
import { processRenditions } from "@/lib/renditions";

/** Long enough for a day's reminders across events. */
export const maxDuration = 60;

/** Stop starting new work this long before maxDuration, so the response always goes out. */
const BUDGET_MS = 50_000;

/**
 * The daily jobs (ADR-0021), for schedulers that call a URL (Vercel Cron, see vercel.json).
 * Same work as the `npm run jobs:*` scripts. Requires `Authorization: Bearer <CRON_SECRET>`,
 * which Vercel Cron sends automatically when CRON_SECRET is set.
 *
 * Order matters (one run has a 60 s budget): time-critical jobs first (caterer headcount locks
 * and alerts, reminders, the outbox), then retention and storage housekeeping with whatever time
 * is left, then a last outbox drain for notices those jobs queued. Each job is isolated.
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
  const jobs: CronJob[] = [
    // [vendor-portal daily jobs]
    { name: "headcountLocks", run: () => freezeAllDueLocks(db, now) },
    { name: "headcountAlerts", run: () => checkHeadcountAlerts(db, now) },
    { name: "taskReminders", run: () => sendTaskReminders(db, now, appUrl) },
    { name: "rsvpReminders", run: () => sendRsvpReminders(db, appUrl, now) },
    { name: "paymentReminders", run: () => sendPaymentReminders(db, now, appUrl) },
    { name: "approvalReminders", run: () => sendApprovalReminders(db, now, appUrl) },
    // [gifts daily jobs]
    { name: "thankYouReminders", run: () => sendThankYouReminders(db, now) },
    // [M7 retention jobs] reminders before the outbox drain, so they go out in this run
    { name: "retentionReminders", run: () => sendRetentionReminders(db, now, appUrl) },
    { name: "outbox", run: async (left) => (await processOutbox(db, { budgetMs: Math.min(20_000, left - 2_000) })).processed, minMs: 3_000 },
    // Housekeeping: with the remaining budget; anything left runs tomorrow.
    { name: "purge", run: () => purgeDeletedEvents(db, now), minMs: 3_000 },
    { name: "retentionPurge", run: (left) => purgeExpiredEvents(db, now, { budgetMs: left - 2_000, appUrl }), minMs: 3_000 },
    // [M7 gallery jobs] uploads whose grant expired (finish or drop), leftover renditions
    { name: "galleryUploads", run: () => sweepUploads(db, getStore(), now) },
    { name: "expiredReservations", run: () => releaseExpiredReservations(db, now) },
    { name: "galleryRenditions", run: async (left) => (await processRenditions(db, getStore(), { budgetMs: Math.min(10_000, left - 2_000) })).processed, minMs: 4_000 },
    { name: "storageDeletions", run: (left) => processStorageDeletions(db, getStore(), now, { budgetMs: Math.min(15_000, left - 2_000) }), minMs: 3_000 },
    { name: "storageReconcile", run: (left) => reconcileStorage(db, getStore(), now, { budgetMs: Math.min(10_000, left - 2_000) }), minMs: 3_000 },
    { name: "galleryOrphans", run: (left) => sweepOrphanObjects(db, getStore(), now, { budgetMs: Math.min(10_000, left - 2_000) }), minMs: 3_000 },
    { name: "oldNotifications", run: () => purgeOldNotifications(db, now) },
    // Notices queued by the retention purge (7-day final notice).
    { name: "outboxFinal", run: async (left) => (await processOutbox(db, { budgetMs: left - 1_000 })).processed, minMs: 2_000 },
  ];
  const result = await runJobs(jobs, { budgetMs: BUDGET_MS, onError: (name, err) => console.error(`cron ${name} failed`, err) });
  const failed = Object.values(result).includes("failed");
  return NextResponse.json(result, { status: failed ? 500 : 200, headers: { "Cache-Control": "no-store" } });
}
