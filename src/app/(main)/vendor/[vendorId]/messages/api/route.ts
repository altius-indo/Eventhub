import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { attachmentForViewer, ChatError, openThread, type ChatViewer } from "@/lib/chat";
import { isUuid } from "@/lib/ids";
import { documentResponse, handlePoll, handlePost } from "@/lib/server/chat-api";
import { getLocale, getSessionContext } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

/**
 * Vendor portal chat (VND-10, MSG-01): the vendor's own thread only. GET polls (or downloads an
 * attachment with ?doc=<id>); POST posts or deletes. App Admins looking in can read, not post.
 */
async function load(vendorId: string) {
  if (!(await getSessionContext())) return { error: NextResponse.json({ error: "signed_out" }, { status: 401 }) };
  if (!isUuid(vendorId)) return { error: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const ctx = await getVendorContext(vendorId);
  const viewer: ChatViewer = { kind: "vendor", userId: ctx.user.id, vendorId, isAppAdmin: ctx.viaAdmin };
  return { ctx, viewer };
}

export async function GET(req: Request, { params }: RouteContext<"/vendor/[vendorId]/messages/api">) {
  const { vendorId } = await params;
  const r = await load(vendorId);
  if ("error" in r) return r.error;
  const db = getDb();
  try {
    const doc = new URL(req.url).searchParams.get("doc");
    if (doc) return documentResponse(r.ctx.event.id, await attachmentForViewer(db, r.ctx.event.id, r.viewer, doc));
    const thread = await openThread(db, r.ctx.event.id, { kind: "vendor", id: vendorId }, r.viewer);
    return handlePoll(req, thread, r.viewer, { locale: await getLocale(), timeZone: r.ctx.event.timezone });
  } catch (e) {
    if (e instanceof ChatError) return NextResponse.json({ error: e.code }, { status: 404 });
    throw e;
  }
}

export async function POST(req: Request, { params }: RouteContext<"/vendor/[vendorId]/messages/api">) {
  const { vendorId } = await params;
  const r = await load(vendorId);
  if ("error" in r) return r.error;
  return handlePost(req, r.ctx.event.id, { kind: "vendor", id: vendorId }, r.viewer, r.ctx.can("portal.chat") && !r.ctx.viaAdmin, { locale: await getLocale(), timeZone: r.ctx.event.timezone });
}
