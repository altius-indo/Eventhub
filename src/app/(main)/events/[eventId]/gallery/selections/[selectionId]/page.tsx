import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { MediaGrid } from "@/components/media-grid";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Field, Input, PageHeader, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { GalleryError, getSelection, selectionItems } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { addFavouritesAction, deleteSelectionAction, removeFromSelectionAction, shareSelectionAction, updateSelectionAction } from "../../actions";

/** One album selection: edit, fill from favourites, share with the photographer (GAL-07). */
export default async function SelectionPage({ params }: PageProps<"/events/[eventId]/gallery/selections/[selectionId]">) {
  const { eventId, selectionId } = await params;
  await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const s = await getSelection(db, eventId, selectionId).catch((e) => {
    if (e instanceof GalleryError) notFound();
    throw e;
  });
  const items = await selectionItems(db, eventId, s.id);
  const base = `/events/${eventId}/gallery`;

  return (
    <div className="space-y-4">
      <Link href={`${base}/favourites`} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        ← {t("gallery.selections.title")}
      </Link>
      <PageHeader title={s.title} subtitle={t("gallery.selections.items", { count: items.length })} />
      <Card className="space-y-3">
        <Badge tone={s.sharedAt ? "success" : "neutral"}>{s.sharedAt ? t("gallery.selections.shared", { date: formatDateTime(locale, s.sharedAt) }) : t("gallery.selections.notShared")}</Badge>
        <SimpleForm action={updateSelectionAction.bind(null, eventId, s.id)} className="space-y-3">
          <Field label={t("gallery.albumTitle")} htmlFor="title">
            <Input id="title" name="title" defaultValue={s.title} required maxLength={80} />
          </Field>
          <Field label={t("gallery.selections.deadline")} htmlFor="deadline">
            <Input id="deadline" name="deadline" type="date" defaultValue={s.deadline ?? ""} />
          </Field>
          <Field label={t("gallery.selections.note")} htmlFor="note">
            <Textarea id="note" name="note" rows={2} defaultValue={s.note ?? ""} maxLength={1000} />
          </Field>
          <SubmitButton variant="secondary">{t("gallery.selections.save")}</SubmitButton>
        </SimpleForm>
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <SimpleForm action={addFavouritesAction.bind(null, eventId, s.id)} className="space-y-2">
            <SubmitButton variant="secondary">{t("gallery.selections.addFavourites")}</SubmitButton>
          </SimpleForm>
          {items.length > 0 && (
            <SimpleForm action={shareSelectionAction.bind(null, eventId, s.id)} className="space-y-2">
              <SubmitButton>{s.sharedAt ? t("gallery.selections.reshare") : t("gallery.selections.share")}</SubmitButton>
            </SimpleForm>
          )}
          <SimpleForm action={deleteSelectionAction.bind(null, eventId, s.id)}>
            <ConfirmButton variant="ghost" confirm={t("gallery.selections.deleteConfirm")}>
              {t("gallery.selections.deleteSelection")}
            </ConfirmButton>
          </SimpleForm>
        </div>
      </Card>
      {items.length === 0 ? (
        <p className="text-sm text-muted">{t("gallery.empty")}</p>
      ) : (
        <MediaGrid
          items={items.map(({ item }) => ({
            id: item.id,
            href: `${base}/media/${item.id}`,
            thumb: `${base}/media/${item.id}/thumb`,
            video: item.kind === "video",
            label: item.filename,
            footer: (
              <div>
                <p className="truncate text-xs text-muted" title={item.filename}>
                  {item.filename}
                </p>
                <form action={removeFromSelectionAction.bind(null, eventId, s.id, item.id)}>
                  <SubmitButton variant="ghost" className="w-full px-1 text-xs">
                    {t("gallery.selections.remove")}
                  </SubmitButton>
                </form>
              </div>
            ),
          }))}
        />
      )}
    </div>
  );
}
