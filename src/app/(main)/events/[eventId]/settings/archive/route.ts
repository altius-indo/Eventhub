import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { createTranslator } from "@/i18n/core";
import { partEntries, PART_ID, recordArchiveDownload, zipStream } from "@/lib/archive";
import { hasRecentStepUp } from "@/lib/auth-core";
import { getEventContext } from "@/lib/server/event-context";
import { getLocale } from "@/lib/server/session";

/** Long enough to zip a big part; the response streams, so this caps the total time (ADR-0033). */
export const maxDuration = 300;

/**
 * EVT-08 full archive: one ZIP per part (`?part=main` by default). Hosts and App Admins only
 * (`event.export`), with a fresh OTP (EVT-01d); every download is audited.
 */
export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/settings/archive">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("event.export")) return new Response("Not found", { status: 404 });
  const partId = new URL(req.url).searchParams.get("part") ?? "main";
  if (!PART_ID.test(partId)) return new Response("Not found", { status: 404 });
  if (!hasRecentStepUp(ctx.session)) {
    redirect(`/step-up?next=${encodeURIComponent(`/events/${eventId}/settings/archive?part=${partId}`)}`);
  }
  const locale = await getLocale();
  const db = getDb();
  const entries = await partEntries({ db, event: ctx.event, t: createTranslator(locale), locale, subject: ctx.subject, actor: ctx.actor, now: new Date() }, partId);
  if (!entries) return new Response("Not found", { status: 404 });
  await recordArchiveDownload(db, eventId, ctx.actor, partId);
  const slug = ctx.event.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "event";
  return new Response(zipStream(entries), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}-${partId}.zip"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
