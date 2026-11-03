import { getEventContext } from "@/lib/server/event-context";
import { handleUploadRequest } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";

/** Members' direct uploads (ADR-0031): begin → browser uploads to storage → complete. */
export async function POST(req: Request, { params }: RouteContext<"/events/[eventId]/gallery/upload">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  // App Admins looking in may view but don't upload as the family.
  if (!ctx.can("gallery.upload") || ctx.viaAdmin) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  return handleUploadRequest(req, eventId, { kind: "member", userId: ctx.user.id }, t);
}
