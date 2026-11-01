import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { CheckInError, lookupPass } from "@/lib/checkin";
import { GiftError, myOpenCash, myRecentEnvelopes, recordEnvelopes, searchGivers, type EnvelopeItem } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getSessionContext } from "@/lib/server/session";

/**
 * JSON endpoint for envelope mode (GFT-02). A route handler, like the check-in desk
 * (ADR-0014), so a queue saved offline still syncs after a redeploy. Same-origin only.
 * Returns only names (no phones or other guest data) and only the collector's own entries.
 */
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("lookup"), raw: z.string().max(500) }),
  z.object({ op: z.literal("search"), q: z.string().max(60) }),
  z.object({ op: z.literal("record"), items: z.array(z.unknown()).max(50) }),
  z.object({ op: z.literal("recent") }),
]);

export async function POST(req: Request, { params }: RouteContext<"/events/[eventId]/gifts/envelope/[functionId]/api">) {
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
  if (!ctx.can("gifts.record")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const db = getDb();
  const c = dctx(ctx);
  const input = parsed.data;
  try {
    switch (input.op) {
      case "lookup": {
        const found = await lookupPass(db, eventId, functionId, input.raw);
        return NextResponse.json({ household: { id: found.household.id, name: found.household.name, members: found.members.map((m) => m.name) } });
      }
      case "search":
        return NextResponse.json({ households: (await searchGivers(db, c, input.q)).map((h) => ({ id: h.id, name: h.name, members: h.members })) });
      case "record":
        // recordEnvelopes validates each entry and reports bad ones one by one.
        return NextResponse.json(await recordEnvelopes(db, c, functionId, input.items as EnvelopeItem[]));
      case "recent": {
        const [recent, mine] = await Promise.all([myRecentEnvelopes(db, c, functionId), myOpenCash(db, c, functionId)]);
        return NextResponse.json({
          recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
          openCount: mine.count,
          openTotalPaise: mine.totalPaise,
        });
      }
    }
  } catch (err) {
    if (err instanceof CheckInError || err instanceof GiftError) return NextResponse.json({ error: err.code }, { status: 422 });
    throw err;
  }
}
