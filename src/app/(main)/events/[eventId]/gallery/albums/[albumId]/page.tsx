import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { GalleryUploader } from "@/components/gallery-uploader";
import { MediaGrid } from "@/components/media-grid";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Field, Input, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { intlLocale } from "@/i18n/core";
import { decodeCursor, formatBytes, GalleryError, getAlbum, LIMITS, listAlbumMedia, listAlbums, readyNotice, splitParts, zipItems } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { ACCEPT_ALL, uploaderLabels } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";
import { deleteAlbumAction, releaseAlbumAction, renameAlbumAction, sendReadyNowAction } from "../../actions";

/** One album: upload (family/delivery albums), release, and the grid in capture order (GAL-01/02). */
export default async function AlbumPage({ params, searchParams }: PageProps<"/events/[eventId]/gallery/albums/[albumId]">) {
  const { eventId, albumId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const album = await getAlbum(db, eventId, albumId).catch((e) => {
    if (e instanceof GalleryError) notFound();
    throw e;
  });
  const [summary] = await listAlbums(db, eventId, { functionId: album.functionId }).then((l) => l.filter((a) => a.id === album.id));
  const page = await listAlbumMedia(db, eventId, album.id, decodeCursor(sp.after));
  const notice = await readyNotice(db, eventId, album.functionId);
  const zipParts = splitParts(await zipItems(db, eventId, { albumId: album.id }));
  const base = `/events/${eventId}/gallery`;
  const name = album.title || t(`gallery.albumKinds.${album.kind}`);
  const canUpload = ctx.can("gallery.upload") && !ctx.viaAdmin && album.kind !== "guest";
  const status = (s: string) => (s === "approved" ? null : <Badge tone={s === "pending" ? "warning" : s === "hidden" ? "danger" : "neutral"}>{t(`gallery.item.status.${s as "pending"}`)}</Badge>);

  return (
    <div className="space-y-4">
      <Link href={base} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        ← {t("gallery.nav.albums")}
      </Link>
      <PageHeader
        title={name}
        subtitle={[summary?.functionName, t("gallery.counts", { approved: summary?.approved ?? 0, pending: summary?.pending ?? 0, hidden: summary?.hidden ?? 0 }), summary && t("gallery.size", { size: formatBytes(intlLocale(locale), summary.bytes) })]
          .filter(Boolean)
          .join(" · ")}
      />

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={album.releasedAt ? "success" : "neutral"}>{album.releasedAt ? t("gallery.released") : t("gallery.notReleased")}</Badge>
          {album.kind !== "family" && <Badge>{t(`gallery.albumKinds.${album.kind}`)}</Badge>}
        </div>
        {ctx.can("gallery.moderate") && album.kind !== "guest" && (
          <SimpleForm action={releaseAlbumAction.bind(null, eventId, album.id, !album.releasedAt)} className="space-y-2">
            <SubmitButton variant={album.releasedAt ? "secondary" : "primary"}>{album.releasedAt ? t("gallery.withdraw") : t("gallery.release")}</SubmitButton>
          </SimpleForm>
        )}
        {ctx.can("gallery.moderate") && album.releasedAt && notice?.status === "quota" && (
          <SimpleForm action={sendReadyNowAction.bind(null, eventId, album.id)} className="space-y-2">
            <p className="text-sm text-warning">{t("gallery.readyPending", { channel: notice.channel ?? "" })}</p>
            <SubmitButton variant="secondary">{t("gallery.sendNow")}</SubmitButton>
          </SimpleForm>
        )}
        <div className="flex flex-wrap gap-2">
          {zipParts.map((p, i) => (
            <a key={i} href={`${base}/download?album=${album.id}&part=${i + 1}`} className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm hover:bg-surface-muted">
              {zipParts.length > 1
                ? t("gallery.download.part", { n: i + 1, total: zipParts.length, size: formatBytes(intlLocale(locale), p.reduce((a, x) => a + x.originalBytes, 0)) })
                : t("gallery.download.album")}
            </a>
          ))}
        </div>
        {ctx.can("gallery.upload") && album.kind === "family" && album.title && (
          <details>
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">{t("gallery.renameAlbum")}</summary>
            <SimpleForm action={renameAlbumAction.bind(null, eventId, album.id)} className="mt-2 flex flex-wrap items-end gap-2">
              <Field label={t("gallery.albumTitle")} htmlFor="rename">
                <Input id="rename" name="title" defaultValue={album.title} required maxLength={80} />
              </Field>
              <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
            </SimpleForm>
          </details>
        )}
        {ctx.can("gallery.moderate") && page.items.length === 0 && !sp.after && (
          <SimpleForm action={deleteAlbumAction.bind(null, eventId, album.id)}>
            <ConfirmButton variant="ghost" confirm={t("gallery.deleteAlbumConfirm")}>
              {t("gallery.deleteAlbum")}
            </ConfirmButton>
          </SimpleForm>
        )}
      </Card>

      {canUpload && (
        <Card className="space-y-2">
          <h2 className="font-semibold">{t("gallery.upload")}</h2>
          <p className="text-sm text-muted">{t("gallery.uploadHelp", { video: "4 GB" })}</p>
          <GalleryUploader
            endpoint={`${base}/upload`}
            functionId={album.functionId}
            albumId={album.id}
            accept={ACCEPT_ALL}
            maxPhotoBytes={LIMITS.photo}
            maxVideoBytes={LIMITS.videoMember}
            labels={uploaderLabels(t)}
          />
        </Card>
      )}

      {(summary?.processing ?? 0) > 0 && (
        <p className="text-sm text-muted">
          {t("gallery.processing", { count: summary!.processing })}{" "}
          <Link href={`${base}/albums/${album.id}`} className="text-primary underline">
            {t("gallery.uploader.refresh")}
          </Link>
        </p>
      )}

      {page.items.length === 0 ? (
        <p className="text-sm text-muted">{t("gallery.empty")}</p>
      ) : (
        <MediaGrid
          items={page.items.map((m) => ({
            id: m.id,
            href: `${base}/media/${m.id}`,
            thumb: `${base}/media/${m.id}/thumb`,
            video: m.kind === "video",
            badge: status(m.status),
            label: m.filename,
          }))}
        />
      )}
      {page.next && (
        <Link href={`${base}/albums/${album.id}?after=${page.next}`} className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm hover:bg-surface-muted">
          {t("gallery.loadMore")}
        </Link>
      )}
    </div>
  );
}
