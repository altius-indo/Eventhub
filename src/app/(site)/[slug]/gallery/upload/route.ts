import { createTranslator, isLocale } from "@/i18n/core";
import { guestGallery, handleUploadRequest } from "@/lib/server/gallery";

/**
 * Guest uploads (GAL-03, ADR-0031): only with the family's link cookie, only when the family
 * switched guest uploads on, only to invited functions; rate-limited per family in beginUpload.
 */
export async function POST(req: Request, { params }: RouteContext<"/[slug]/gallery/upload">) {
  const { slug } = await params;
  const g = await guestGallery(slug);
  if (!g) return new Response("Not found", { status: 404 });
  const t = createTranslator(isLocale(g.guest.household.locale) ? g.guest.household.locale : "en");
  return handleUploadRequest(req, g.event.id, { kind: "guest", householdId: g.guest.household.id }, t);
}
