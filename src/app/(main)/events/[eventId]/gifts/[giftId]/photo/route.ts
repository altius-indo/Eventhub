import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { DocumentError, MAX_DOCUMENT_BYTES, saveDocument } from "@/lib/documents";
import { getGift, GiftError } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getSessionContext } from "@/lib/server/session";

/**
 * Photo of a gift item (GFT-01). Its own route rather than the shared documents upload, so the
 * gift privacy rules apply: only someone who may change this gift can attach a photo.
 */
export async function POST(req: Request, { params }: RouteContext<"/events/[eventId]/gifts/[giftId]/photo">) {
  const { eventId, giftId } = await params;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!originHost || originHost !== host) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  if (!(await getSessionContext())) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  if (!isUuid(eventId) || !isUuid(giftId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record")) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const back = `/events/${eventId}/gifts/${giftId}`;
  const go = (q: string) => NextResponse.redirect(new URL(`${back}?${q}`, req.url), 303);
  const declared = Number(req.headers.get("content-length") ?? "");
  if (!Number.isFinite(declared) || declared <= 0) return NextResponse.json({ error: "length_required" }, { status: 411 });
  if (declared > MAX_DOCUMENT_BYTES + 512 * 1024) return go("photoError=too_large");

  const db = getDb();
  const gift = await getGift(db, dctx(ctx), giftId).catch((e) => {
    if (e instanceof GiftError) return null;
    throw e;
  });
  if (!gift) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (gift.handedOver && !ctx.can("gifts.view")) return go("photoError=invalid");
  const fd = await req.formData().catch(() => null);
  const file = fd?.get("file");
  if (!(file instanceof File)) return go("photoError=invalid");
  if (file.size > MAX_DOCUMENT_BYTES) return go("photoError=too_large");
  const data = Buffer.from(await file.arrayBuffer());
  try {
    await saveDocument(db, eventId, ctx.actor, { owner: { giftId }, kind: "other", filename: file.name, data });
  } catch (e) {
    if (e instanceof DocumentError) return go(`photoError=${e.code}`);
    throw e;
  }
  return go("photo=ok");
}
