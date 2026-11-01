import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import {
  addWalkIn,
  checkIn,
  checkInCounts,
  CheckInError,
  lookupPass,
  recentCheckIns,
  searchForCheckIn,
  undoCheckIn,
  type CheckInHousehold,
} from "@/lib/checkin";
import { getEventContext } from "@/lib/server/event-context";

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

export async function POST(req: Request, { params }: RouteContext<"/events/[eventId]/logistics/check-in/[functionId]/api">) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("checkin.operate")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(functionId)) return NextResponse.json({ error: "function_not_found" }, { status: 404 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const db = getDb();
  const input = parsed.data;
  try {
    switch (input.op) {
      case "lookup":
        return NextResponse.json({ household: publicHousehold(await lookupPass(db, eventId, functionId, input.raw)) });
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
