import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { ChatError, openThread, parseThreadKey, type ChatViewer } from "@/lib/chat";
import { isUuid } from "@/lib/ids";
import { handlePoll, handlePost } from "@/lib/server/chat-api";
import { getEventContext } from "@/lib/server/event-context";
import { getLocale, getSessionContext } from "@/lib/server/session";

/** Chat polling and posting for team members (MSG-01, ADR-0026). */
async function load(eventId: string, threadId: string) {
  // Check the session ourselves: a redirect to /login would look like success to fetch().
  if (!(await getSessionContext())) return { error: NextResponse.json({ error: "signed_out" }, { status: 401 }) };
  const key = parseThreadKey(threadId);
  if (!isUuid(eventId) || !key) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const ctx = await getEventContext(eventId);
  const viewer: ChatViewer = { kind: "member", userId: ctx.user.id, isAppAdmin: ctx.viaAdmin };
  return { ctx, key, viewer };
}

export async function GET(req: Request, { params }: RouteContext<"/events/[eventId]/messages/[threadId]/api">) {
  const { eventId, threadId } = await params;
  const r = await load(eventId, threadId);
  if ("error" in r) return r.error;
  try {
    const thread = await openThread(getDb(), eventId, r.key, r.viewer);
    return handlePoll(req, thread, r.viewer, { locale: await getLocale(), timeZone: r.ctx.event.timezone });
  } catch (e) {
    if (e instanceof ChatError) return NextResponse.json({ error: e.code }, { status: 404 });
    throw e;
  }
}

export async function POST(req: Request, { params }: RouteContext<"/events/[eventId]/messages/[threadId]/api">) {
  const { eventId, threadId } = await params;
  const r = await load(eventId, threadId);
  if ("error" in r) return r.error;
  return handlePost(req, eventId, r.key, r.viewer, r.ctx.can("chat.post"), { locale: await getLocale(), timeZone: r.ctx.event.timezone });
}
