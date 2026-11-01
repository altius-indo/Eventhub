import { handleUploadRequest } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

/** Photographer/videographer deliveries (GAL-02, ADR-0031). Booking checks happen in beginUpload. */
export async function POST(req: Request, { params }: RouteContext<"/vendor/[vendorId]/gallery/upload">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.gallery")) return new Response("Not found", { status: 404 });
  const { t } = await getTranslator();
  return handleUploadRequest(req, ctx.event.id, { kind: "vendor", vendorId, userId: ctx.user.id }, t);
}
