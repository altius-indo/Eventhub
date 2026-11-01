import Link from "next/link";
import { notFound } from "next/navigation";
import { MediaGrid } from "@/components/media-grid";
import { SubmitButton } from "@/components/submit-button";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { decodeCursor, moderationQueue } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { moderateAction } from "../actions";

/** Moderation queue (GAL-04): guest uploads wait here until approved or hidden. */
export default async function ReviewPage({ params, searchParams }: PageProps<"/events/[eventId]/gallery/review">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gallery.moderate")) notFound();
  const { t } = await getTranslator();
  const page = await moderationQueue(getDb(), eventId, decodeCursor(sp.after), 48);
  const base = `/events/${eventId}/gallery`;
  return (
    <div className="space-y-4">
      <PageHeader title={t("gallery.review.title")} subtitle={t("gallery.review.help")} />
      {page.items.length === 0 ? (
        <p className="text-sm text-muted">{t("gallery.review.empty")}</p>
      ) : (
        <>
          <form action={moderateAction.bind(null, eventId, page.items.map((i) => i.id), "approve")}>
            <SubmitButton>{t("gallery.review.approveAll")}</SubmitButton>
          </form>
          <MediaGrid
            items={page.items.map((m) => ({
              id: m.id,
              href: `${base}/media/${m.id}`,
              thumb: `${base}/media/${m.id}/thumb`,
              video: m.kind === "video",
              label: m.filename,
              footer: (
                <div className="flex gap-1">
                  <form action={moderateAction.bind(null, eventId, [m.id], "approve")} className="flex-1">
                    <SubmitButton className="w-full px-1 text-xs">{t("gallery.item.approve")}</SubmitButton>
                  </form>
                  <form action={moderateAction.bind(null, eventId, [m.id], "hide")} className="flex-1">
                    <SubmitButton variant="secondary" className="w-full px-1 text-xs">
                      {t("gallery.item.hide")}
                    </SubmitButton>
                  </form>
                </div>
              ),
            }))}
          />
          {page.next && (
            <Link href={`${base}/review?after=${page.next}`} className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm hover:bg-surface-muted">
              {t("gallery.loadMore")}
            </Link>
          )}
        </>
      )}
    </div>
  );
}
