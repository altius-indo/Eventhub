"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getDb } from "@/db";
import { createVendorAlbum, deleteVendorUpload, GalleryError } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { getStore } from "@/lib/storage";
import { runStorageDeletions } from "@/lib/storage-gc";

type State = { error?: string; info?: string };

/** A delivery album for a booked function, e.g. "Sneak peek" or "Full delivery" (GAL-02). */
export async function createVendorAlbumAction(vendorId: string, functionId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getVendorContext(vendorId);
  const { t } = await getTranslator();
  if (ctx.viaAdmin || !ctx.can("portal.gallery") || !isUuid(functionId)) return { error: t("common.notAllowed") };
  let id: string;
  try {
    id = (await createVendorAlbum(getDb(), { eventId: ctx.event.id, vendorId, userId: ctx.user.id, functionId, title: String(fd.get("title") ?? "") })).id;
  } catch (e) {
    if (e instanceof GalleryError) return { error: t(`gallery.errors.${e.code}`) };
    throw e;
  }
  redirect(`/vendor/${vendorId}/gallery/albums/${id}`);
}

/** Removes one of the vendor's own files from an album that isn't released yet. */
export async function deleteVendorFileAction(vendorId: string, albumId: string, mediaId: string, _p: State): Promise<State> {
  const ctx = await getVendorContext(vendorId);
  const { t } = await getTranslator();
  if (ctx.viaAdmin || !ctx.can("portal.gallery") || !isUuid(mediaId)) return { error: t("common.notAllowed") };
  let ids: number[];
  try {
    ids = await deleteVendorUpload(getDb(), { eventId: ctx.event.id, vendorId, mediaId });
  } catch (e) {
    if (e instanceof GalleryError) return { error: t(`gallery.errors.${e.code}`) };
    throw e;
  }
  after(() => runStorageDeletions(getDb(), getStore(), ids));
  revalidatePath(`/vendor/${vendorId}/gallery/albums/${albumId}`);
  return {};
}
