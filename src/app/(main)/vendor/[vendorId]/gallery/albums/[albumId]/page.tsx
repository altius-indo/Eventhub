import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { GalleryUploader } from "@/components/gallery-uploader";
import { MediaGrid } from "@/components/media-grid";
import { SimpleForm } from "@/components/simple-form";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { decodeCursor, GalleryError, getAlbum, LIMITS, listAlbumMedia } from "@/lib/gallery";
import { ACCEPT_ALL, uploaderLabels } from "@/lib/server/gallery";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { deleteVendorFileAction } from "../../actions";

/** A vendor's delivery album: bulk upload with progress, and their files (GAL-02). */
export default async function VendorAlbumPage({ params, searchParams }: PageProps<"/vendor/[vendorId]/gallery/albums/[albumId]">) {
  const { vendorId, albumId } = await params;
  const sp = await searchParams;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.gallery") && !ctx.viaAdmin) notFound();
  const { t } = await getTranslator();
  const db = getDb();
  const album = await getAlbum(db, ctx.event.id, albumId).catch((e) => {
    if (e instanceof GalleryError) notFound();
    throw e;
  });
  if (album.vendorId !== vendorId || album.kind !== "delivery") notFound();
  const page = await listAlbumMedia(db, ctx.event.id, album.id, decodeCursor(sp.after), { vendorId });
  const base = `/vendor/${vendorId}/gallery`;
  const writable = ctx.can("portal.gallery") && !album.releasedAt;

  return (
    <div className="space-y-4">
      <Link href={base} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        ← {t("gallery.vendor.title")}
      </Link>
      <PageHeader title={album.title} />
      <Badge tone={album.releasedAt ? "success" : "neutral"}>{album.releasedAt ? t("gallery.released") : t("gallery.notReleased")}</Badge>
      {album.releasedAt && <Alert>{t("gallery.vendor.lockedAfterRelease")}</Alert>}
      {writable && (
        <Card className="space-y-2">
          <h2 className="font-semibold">{t("gallery.upload")}</h2>
          <p className="text-sm text-muted">{t("gallery.uploadHelp", { video: "4 GB" })}</p>
          <GalleryUploader
            endpoint={`${base}/upload`}
            functionId={album.functionId}
            albumId={album.id}
            accept={ACCEPT_ALL}
            maxPhotoBytes={LIMITS.photo}
            maxVideoBytes={LIMITS.videoVendor}
            labels={uploaderLabels(t)}
          />
        </Card>
      )}
      {page.items.length === 0 ? (
        <p className="text-sm text-muted">{t("gallery.empty")}</p>
      ) : (
        <MediaGrid
          items={page.items.map((m) => ({
            id: m.id,
            href: `${base}/media/${m.id}/web`,
            file: true,
            thumb: `${base}/media/${m.id}/thumb`,
            video: m.kind === "video",
            label: m.filename,
            footer: (
              <div>
                <p className="truncate text-xs text-muted" title={m.filename}>
                  {m.filename}
                </p>
                {writable && (
                  <SimpleForm action={deleteVendorFileAction.bind(null, vendorId, album.id, m.id)} className="space-y-1">
                    <ConfirmButton variant="ghost" className="w-full px-1 text-xs" confirm={t("gallery.vendor.deleteConfirm")}>
                      {t("gallery.vendor.deleteFile")}
                    </ConfirmButton>
                  </SimpleForm>
                )}
              </div>
            ),
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
