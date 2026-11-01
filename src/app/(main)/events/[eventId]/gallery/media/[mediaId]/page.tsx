import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, Field, Select } from "@/components/ui";
import { getDb } from "@/db";
import { households, users, vendors } from "@/db/schema";
import { formatDateTime, intlLocale } from "@/i18n/core";
import { eq } from "drizzle-orm";
import { formatBytes, isFavourite, listSelections, loadMediaForViewer, reactionsFor } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { addToSelectionAction, deleteMediaAction, hideCommentAction, moderateAction, setHighlightAction, toggleFavouriteAction } from "../../actions";

/** One photo or video for the team: view, favourite, highlight, moderate, select, delete. */
export default async function MediaPage({ params }: PageProps<"/events/[eventId]/gallery/media/[mediaId]">) {
  const { eventId, mediaId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const item = await loadMediaForViewer(db, eventId, mediaId, { kind: "member" });
  if (!item) notFound();
  const base = `/events/${eventId}/gallery`;
  const src = (v: string) => `${base}/media/${item.id}/${v}`;
  const [fav, selections, reactions, who] = await Promise.all([
    isFavourite(db, item.id, ctx.user.id),
    listSelections(db, eventId),
    reactionsFor(db, item.id, { member: true }),
    item.uploaderKind === "household" && item.householdId
      ? db.select({ name: households.name }).from(households).where(eq(households.id, item.householdId)).then((r) => r[0]?.name)
      : item.uploaderKind === "vendor" && item.vendorId
        ? db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, item.vendorId)).then((r) => r[0]?.name)
        : item.userId
          ? db.select({ name: users.name }).from(users).where(eq(users.id, item.userId)).then((r) => r[0]?.name)
          : Promise.resolve(null),
  ]);
  const moderateOk = ctx.can("gallery.moderate");

  return (
    <div className="space-y-4">
      <Link href={`${base}/albums/${item.albumId}`} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        ← {t("gallery.item.back")}
      </Link>
      <div className="overflow-hidden rounded-xl bg-black">
        {item.kind === "video" ? (
          <video src={src("web")} controls preload="metadata" playsInline className="mx-auto max-h-[75vh] w-full" />
        ) : item.webKey ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src("web")} alt={item.filename} className="mx-auto max-h-[75vh] w-auto object-contain" />
        ) : (
          <p className="p-6 text-center text-sm text-white">{item.status === "processing" ? t("gallery.item.status.processing") : t("gallery.item.previewFailed")}</p>
        )}
      </div>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={item.status === "approved" ? "success" : item.status === "pending" ? "warning" : item.status === "hidden" ? "danger" : "neutral"}>{t(`gallery.item.status.${item.status}`)}</Badge>
          {item.highlight && <Badge tone="primary">{t("gallery.item.highlighted")}</Badge>}
        </div>
        <p className="break-all text-sm">
          {item.filename} · {formatBytes(intlLocale(locale), item.originalBytes)}
        </p>
        <p className="text-sm text-muted">{t("gallery.item.taken", { date: formatDateTime(locale, item.takenAt) })}</p>
        <p className="text-sm text-muted">{t("gallery.item.uploadedBy", { who: [t(`gallery.uploaderKinds.${item.uploaderKind}`), who].filter(Boolean).join(" · ") })}</p>

        <div className="flex flex-wrap gap-2">
          <form action={toggleFavouriteAction.bind(null, eventId, item.id)}>
            <SubmitButton variant={fav ? "primary" : "secondary"} aria-pressed={fav}>
              {fav ? `★ ${t("gallery.item.unfavourite")}` : `☆ ${t("gallery.item.favourite")}`}
            </SubmitButton>
          </form>
          <a href={src("download")} className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm hover:bg-surface-muted">
            {t("gallery.download.original")}
          </a>
        </div>

        {moderateOk && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {item.status !== "approved" && ["pending", "hidden"].includes(item.status) && (
              <form action={moderateAction.bind(null, eventId, [item.id], "approve")}>
                <SubmitButton>{t("gallery.item.approve")}</SubmitButton>
              </form>
            )}
            {["pending", "approved"].includes(item.status) && (
              <form action={moderateAction.bind(null, eventId, [item.id], "hide")}>
                <SubmitButton variant="secondary">{t("gallery.item.hide")}</SubmitButton>
              </form>
            )}
            {item.kind === "photo" && item.status === "approved" && (
              <SimpleForm action={setHighlightAction.bind(null, eventId, item.id, !item.highlight)} className="space-y-2">
                <SubmitButton variant="secondary">{item.highlight ? t("gallery.item.unhighlight") : t("gallery.item.highlight")}</SubmitButton>
              </SimpleForm>
            )}
            <SimpleForm action={deleteMediaAction.bind(null, eventId, item.id, item.albumId)}>
              <ConfirmButton variant="danger" confirm={t("gallery.item.deleteConfirm")}>
                {t("gallery.item.delete")}
              </ConfirmButton>
            </SimpleForm>
          </div>
        )}

        {selections.length > 0 && (
          <SimpleForm action={addToSelectionAction.bind(null, eventId, item.id)} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <Field label={t("gallery.item.addToSelection")} htmlFor="selectionId">
              <Select id="selectionId" name="selectionId" required>
                {selections.map((s) => (
                  <option key={s.selection.id} value={s.selection.id}>
                    {s.selection.title}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton variant="secondary">{t("gallery.item.addToSelection")}</SubmitButton>
          </SimpleForm>
        )}
      </Card>

      {(reactions.likes > 0 || reactions.comments.length > 0) && (
        <Card className="space-y-2">
          <p className="text-sm">{t("gallery.item.likes", { count: reactions.likes })}</p>
          <h2 className="font-semibold">{t("gallery.item.comments")}</h2>
          <ul className="space-y-2">
            {reactions.comments.map((c) => (
              <li key={c.id} className="rounded-md bg-surface-muted p-3 text-sm">
                <p className="font-medium">
                  {c.family} {c.hidden && <Badge tone="danger">{t("gallery.item.hiddenComment")}</Badge>}
                </p>
                <p className="whitespace-pre-line">{c.body}</p>
                {moderateOk && (
                  <form action={hideCommentAction.bind(null, eventId, item.id, c.id, !c.hidden)} className="mt-1">
                    <SubmitButton variant="ghost" className="min-h-10 px-2">
                      {c.hidden ? t("gallery.item.showComment") : t("gallery.item.hideComment")}
                    </SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {item.previewError && item.kind === "photo" && <Alert>{t("gallery.item.previewFailed")}</Alert>}
    </div>
  );
}
