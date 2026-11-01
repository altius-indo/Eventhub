import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  addWalkIn,
  checkIn,
  checkInCounts,
  checkInSnapshot,
  CheckInError,
  lookupPass,
  recentCheckIns,
  searchForCheckIn,
  undoCheckIn,
  type CheckInHousehold,
} from "@/lib/checkin";
import { getEventContext } from "@/lib/server/event-context";
import { getSessionContext } from "@/lib/server/session";
import { isUuid } from "@/lib/ids";

/**
 * JSON endpoint for the check-in desk (ADR-0014). A route handler rather than a server
 * action so queued check-ins still sync after a redeploy. Same-origin only.
 */
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("lookup"), raw: z.string().max(500) }),
  z.object({ op: z.literal("search"), q: z.string().max(60) }),
  z.object({
    op: z.literal("checkin"),
    items: z.array(z.object({ guestId: z.string().uuid(), at: z.string().datetime().optional(), source: z.enum(["scan", "manual"]) })).max(50),
    allowUninvited: z.boolean().optional(),
  }),
  z.object({ op: z.literal("undo"), guestId: z.string().uuid() }),
  z.object({ op: z.literal("walkin"), name: z.string().min(1).max(120), side: z.enum(["bride", "groom", "both"]), count: z.number().int().min(1).max(20) }),
  z.object({ op: z.literal("counts") }),
]);

/** Only what the desk needs: no phones, emails, addresses or gift data. */
function publicHousehold(h: CheckInHousehold) {
  return {
    id: h.household.id,
    name: h.household.name,
    side: h.household.side,
    members: h.members.map((m) => ({
      id: m.id,
      name: m.name,
      ageGroup: m.ageGroup,
      invited: m.invited,
      rsvp: m.rsvp,
      checkedInAt: m.checkedInAt?.toISOString() ?? null,
      checkedInBy: m.checkedInBy,
    })),
  };
}

/**
 * Offline snapshot (SEAT-04, ADR-0034): the desk caches this in localStorage so pass lookup and
 * name search work when it opens without a connection. Members with check-in rights only.
 */
export async function GET(_req: Request, { params }: RouteContext<"/events/[eventId]/logistics/check-in/[functionId]/api">) {
  const { eventId, functionId } = await params;
  const noStore = { "Cache-Control": "private, no-store" };
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ error: "signed_out" }, { status: 401, headers: noStore });
  if (!isUuid(eventId) || !isUuid(functionId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  const ctx = await getEventContext(eventId);
  if (!ctx.can("checkin.operate")) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  try {
    return NextResponse.json(await checkInSnapshot(getDb(), eventId, functionId), { headers: noStore });
  } catch (err) {
    if (err instanceof CheckInError) return NextResponse.json({ error: err.code }, { status: 404, headers: noStore });
    throw err;
  }
}

export async function POST(req: Request, { params }: RouteContext<"/events/[eventId]/logistics/check-in/[functionId]/api">) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!originHost || !host || originHost !== host) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const { eventId, functionId } = await params;
  // Check the session ourselves: a redirect to /login would look like success to fetch().
  const session = await getSessionContext();
  if (!session) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  if (!isUuid(eventId) || !isUuid(functionId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ctx = await getEventContext(eventId);
  if (!ctx.can("checkin.operate")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const db = getDb();
  const input = parsed.data;
  try {
    switch (input.op) {
      case "lookup": {
        const found = await lookupPass(db, eventId, functionId, input.raw);
        return NextResponse.json({ household: publicHousehold(found), legacy: found.legacy });
      }
      case "search":
        return NextResponse.json({ households: (await searchForCheckIn(db, eventId, functionId, input.q)).map(publicHousehold) });
      case "checkin":
        return NextResponse.json(
          await checkIn(
            db,
            eventId,
            functionId,
            ctx.actor,
            input.items.map((i) => ({ guestId: i.guestId, source: i.source, at: i.at ? new Date(i.at) : undefined })),
            { allowUninvited: input.allowUninvited },
          ),
        );
      case "undo":
        await undoCheckIn(db, eventId, functionId, input.guestId, ctx.actor);
        return NextResponse.json({ ok: true });
      case "walkin":
        return NextResponse.json(await addWalkIn(db, eventId, functionId, ctx.actor, input));
      case "counts": {
        const [counts, recent] = await Promise.all([checkInCounts(db, eventId, functionId), recentCheckIns(db, eventId, functionId)]);
        return NextResponse.json({ counts, recent: recent.map((r) => ({ ...r, at: r.at.toISOString() })) });
      }
    }
  } catch (err) {
    if (err instanceof CheckInError) return NextResponse.json({ error: err.code }, { status: 422 });
    throw err;
  }
}
