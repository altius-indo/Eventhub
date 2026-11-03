"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getDb } from "@/db";
import { createTranslator, type Locale } from "@/i18n/core";
import { addComment, deleteOwnUpload, GalleryError, requestRemoval, toggleLike } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { guestGallery } from "@/lib/server/gallery";
import { getStore } from "@/lib/storage";
import { runStorageDeletions } from "@/lib/storage-gc";

type State = { error?: string; info?: string };

const lang = (l: string): Locale => (l === "hi" ? "hi" : "en");
const photoPath = (slug: string, mediaId: string) => `/${slug}/gallery/photo/${mediaId}`;

async function guard(slug: string, mediaId: string, locale: string) {
  const t = createTranslator(lang(locale));
  const g = isUuid(mediaId) ? await guestGallery(slug) : null;
  return { g, t };
}

function errorText(t: ReturnType<typeof createTranslator>, e: unknown) {
  if (e instanceof GalleryError) return t(`gallery.errors.${e.code}`);
  throw e;
}

/** Like / unlike (GAL-08). */
export async function likeAction(slug: string, locale: string, mediaId: string, _p: State): Promise<State> {
  const { g, t } = await guard(slug, mediaId, locale);
  if (!g) return { error: t("gallery.errors.not_found") };
  try {
    await toggleLike(getDb(), g.event.id, g.viewer, mediaId);
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(photoPath(slug, mediaId));
  return {};
}

export async function commentAction(slug: string, locale: string, mediaId: string, _p: State, fd: FormData): Promise<State> {
  const { g, t } = await guard(slug, mediaId, locale);
  if (!g) return { error: t("gallery.errors.not_found") };
  try {
    await addComment(getDb(), g.event.id, g.viewer, mediaId, String(fd.get("body") ?? ""));
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(photoPath(slug, mediaId));
  return { info: t("common.saved") };
}

/** "Please remove this photo of me" (GAL-04). */
export async function removalAction(slug: string, locale: string, mediaId: string, _p: State, fd: FormData): Promise<State> {
  const { g, t } = await guard(slug, mediaId, locale);
  if (!g) return { error: t("gallery.errors.not_found") };
  try {
    await requestRemoval(getDb(), g.event.id, g.viewer, mediaId, String(fd.get("reason") ?? ""));
  } catch (e) {
    return { error: errorText(t, e) };
  }
  return { info: t("gallery.site.removalSent") };
}

export async function deleteOwnAction(slug: string, locale: string, mediaId: string, functionId: string, _p: State): Promise<State> {
  const { g, t } = await guard(slug, mediaId, locale);
  if (!g) return { error: t("gallery.errors.not_found") };
  let ids: number[];
  try {
    ids = await deleteOwnUpload(getDb(), { eventId: g.event.id, householdId: g.guest.household.id, mediaId });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  after(() => runStorageDeletions(getDb(), getStore(), ids));
  redirect(`/${slug}/gallery?fn=${isUuid(functionId) ? functionId : ""}`);
}
