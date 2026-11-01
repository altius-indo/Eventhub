"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getDb } from "@/db";
import type { Translator } from "@/i18n/core";
import {
  addToSelection,
  createAlbum,
  createSelection,
  decideRemoval,
  deleteAlbum,
  deleteMedia,
  deleteSelection,
  GalleryError,
  hideComment,
  moderate,
  releaseAlbum,
  removeFromSelection,
  renameAlbum,
  setHighlight,
  shareSelection,
  toggleFavourite,
  updateGallerySettings,
  updateSelection,
} from "@/lib/gallery";
import { isUuid, uuids } from "@/lib/ids";
import type { Permission } from "@/lib/policy";
import { getEventContext } from "@/lib/server/event-context";
import { drainSoon } from "@/lib/server/drain";
import { appUrl, getTranslator } from "@/lib/server/session";
import { getStore } from "@/lib/storage";
import { runStorageDeletions } from "@/lib/storage-gc";

type State = { error?: string; info?: string };

function errorText(t: Translator, e: unknown): string {
  if (e instanceof GalleryError) return t(`gallery.errors.${e.code}`);
  throw e;
}

async function guard(eventId: string, permission: Permission) {
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  return { ctx, t, locale, ok: ctx.can(permission) };
}

const base = (eventId: string) => `/events/${eventId}/gallery`;
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

function deleteSoon(ids: number[]) {
  if (ids.length) after(() => runStorageDeletions(getDb(), getStore(), ids));
}

// Albums --------------------------------------------------------------------

export async function createAlbumAction(eventId: string, functionId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.upload");
  if (!ok || !isUuid(functionId)) return { error: t("common.notAllowed") };
  let id: string;
  try {
    id = (await createAlbum(getDb(), { eventId, actor: ctx.actor, functionId, title: str(fd, "title") })).id;
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(base(eventId), "layout");
  redirect(`${base(eventId)}/albums/${id}`);
}

export async function renameAlbumAction(eventId: string, albumId: string, _p: State, fd: FormData): Promise<State> {
  const { t, ok } = await guard(eventId, "gallery.upload");
  if (!ok || !isUuid(albumId)) return { error: t("common.notAllowed") };
  try {
    await renameAlbum(getDb(), { eventId, albumId, title: str(fd, "title") });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(base(eventId), "layout");
  return { info: t("common.saved") };
}

export async function deleteAlbumAction(eventId: string, albumId: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.moderate");
  if (!ok || !isUuid(albumId)) return { error: t("common.notAllowed") };
  try {
    await deleteAlbum(getDb(), { eventId, actor: ctx.actor, albumId });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(base(eventId), "layout");
  redirect(base(eventId));
}

export async function releaseAlbumAction(eventId: string, albumId: string, release: boolean, _p: State): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.moderate");
  if (!ok || !isUuid(albumId)) return { error: t("common.notAllowed") };
  let res;
  try {
    res = await releaseAlbum(getDb(), { eventId, actor: ctx.actor, albumId, release, appUrl: appUrl() });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  if (res.notified > 0) drainSoon();
  revalidatePath(base(eventId), "layout");
  if (!release) return { info: t("gallery.withdrawnInfo") };
  if (res.quota) return { info: t("gallery.quotaInfo", { channel: res.quota }) };
  return { info: res.notified > 0 ? t("gallery.notifiedInfo", { count: res.notified }) : t("gallery.releasedInfo") };
}

// Items ---------------------------------------------------------------------

/** One-click moderation buttons (tiles, item page, "approve all"). */
export async function moderateAction(eventId: string, mediaIds: string[], action: "approve" | "hide") {
  const { ctx, ok } = await guard(eventId, "gallery.moderate");
  if (!ok) return;
  await moderate(getDb(), { eventId, actor: ctx.actor, mediaIds: uuids(mediaIds), action });
  revalidatePath(base(eventId), "layout");
}

export async function deleteMediaAction(eventId: string, mediaId: string, albumId: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.moderate");
  if (!ok || !isUuid(mediaId) || !isUuid(albumId)) return { error: t("common.notAllowed") };
  deleteSoon(await deleteMedia(getDb(), { eventId, actor: ctx.actor, mediaIds: [mediaId] }));
  revalidatePath(base(eventId), "layout");
  redirect(`${base(eventId)}/albums/${albumId}`);
}

export async function toggleFavouriteAction(eventId: string, mediaId: string) {
  const { ctx, ok } = await guard(eventId, "gallery.view");
  if (!ok || !isUuid(mediaId)) return;
  try {
    await toggleFavourite(getDb(), { eventId, userId: ctx.user.id, mediaId });
  } catch (e) {
    if (!(e instanceof GalleryError)) throw e;
  }
  revalidatePath(`${base(eventId)}/media/${mediaId}`);
  revalidatePath(`${base(eventId)}/favourites`);
}

export async function setHighlightAction(eventId: string, mediaId: string, on: boolean, _p: State): Promise<State> {
  const { t, ok } = await guard(eventId, "gallery.moderate");
  if (!ok || !isUuid(mediaId)) return { error: t("common.notAllowed") };
  try {
    await setHighlight(getDb(), { eventId, mediaId, on });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(`${base(eventId)}/media/${mediaId}`);
  return { info: t("common.saved") };
}

export async function addToSelectionAction(eventId: string, mediaId: string, _p: State, fd: FormData): Promise<State> {
  const { t, ok } = await guard(eventId, "gallery.view");
  const selectionId = str(fd, "selectionId");
  if (!ok || !isUuid(mediaId) || !isUuid(selectionId)) return { error: t("common.notAllowed") };
  try {
    await addToSelection(getDb(), { eventId, selectionId, mediaIds: [mediaId] });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(`${base(eventId)}/selections/${selectionId}`);
  return { info: t("gallery.item.added") };
}

export async function hideCommentAction(eventId: string, mediaId: string, commentId: string, hidden: boolean) {
  const { ctx, ok } = await guard(eventId, "gallery.moderate");
  if (!ok || !isUuid(commentId)) return;
  await hideComment(getDb(), { eventId, actor: ctx.actor, commentId, hidden });
  revalidatePath(`${base(eventId)}/media/${mediaId}`);
}

// Settings ------------------------------------------------------------------

export async function saveSettingsAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.moderate");
  if (!ok) return { error: t("common.notAllowed") };
  const on = (k: string) => fd.get(k) === "on";
  try {
    await updateGallerySettings(getDb(), eventId, ctx.actor, {
      guestUploads: on("guestUploads"),
      autoApprove: on("autoApprove"),
      guestOriginals: on("guestOriginals"),
      reactions: on("reactions"),
      watermarkText: str(fd, "watermarkText"),
    });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(base(eventId), "layout");
  return { info: t("gallery.settings.saved") };
}

// Album selections (GAL-07) -------------------------------------------------

export async function createSelectionAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.view");
  if (!ok) return { error: t("common.notAllowed") };
  let id: string;
  try {
    id = (
      await createSelection(getDb(), eventId, ctx.actor, {
        bookingId: str(fd, "bookingId"),
        title: str(fd, "title"),
        deadline: str(fd, "deadline") || null,
        note: str(fd, "note") || null,
      })
    ).id;
  } catch (e) {
    return { error: errorText(t, e) };
  }
  redirect(`${base(eventId)}/selections/${id}`);
}

export async function updateSelectionAction(eventId: string, selectionId: string, _p: State, fd: FormData): Promise<State> {
  const { t, ok } = await guard(eventId, "gallery.view");
  if (!ok || !isUuid(selectionId)) return { error: t("common.notAllowed") };
  try {
    await updateSelection(getDb(), eventId, selectionId, { title: str(fd, "title"), deadline: str(fd, "deadline") || null, note: str(fd, "note") || null });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(`${base(eventId)}/selections/${selectionId}`);
  return { info: t("common.saved") };
}

export async function addFavouritesAction(eventId: string, selectionId: string, _p: State): Promise<State> {
  const { t, ok } = await guard(eventId, "gallery.view");
  if (!ok || !isUuid(selectionId)) return { error: t("common.notAllowed") };
  let n: number;
  try {
    n = await addToSelection(getDb(), { eventId, selectionId, favourites: true });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(`${base(eventId)}/selections/${selectionId}`);
  return { info: t("gallery.selections.addedInfo", { count: n }) };
}

export async function removeFromSelectionAction(eventId: string, selectionId: string, mediaId: string) {
  const { ok } = await guard(eventId, "gallery.view");
  if (!ok || !isUuid(selectionId) || !isUuid(mediaId)) return;
  await removeFromSelection(getDb(), { eventId, selectionId, mediaId });
  revalidatePath(`${base(eventId)}/selections/${selectionId}`);
}

export async function shareSelectionAction(eventId: string, selectionId: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.view");
  if (!ok || !isUuid(selectionId)) return { error: t("common.notAllowed") };
  try {
    await shareSelection(getDb(), { eventId, actor: ctx.actor, selectionId });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(`${base(eventId)}/selections/${selectionId}`);
  return { info: t("gallery.selections.sharedInfo") };
}

export async function deleteSelectionAction(eventId: string, selectionId: string, _p: State): Promise<State> {
  const { t, ok } = await guard(eventId, "gallery.view");
  if (!ok || !isUuid(selectionId)) return { error: t("common.notAllowed") };
  try {
    await deleteSelection(getDb(), { eventId, selectionId });
  } catch (e) {
    return { error: errorText(t, e) };
  }
  redirect(`${base(eventId)}/favourites`);
}

// Removal requests (GAL-04) -------------------------------------------------

export async function decideRemovalAction(eventId: string, requestId: string, decision: "remove" | "keep", _p: State): Promise<State> {
  const { ctx, t, ok } = await guard(eventId, "gallery.moderate");
  if (!ok || !isUuid(requestId)) return { error: t("common.notAllowed") };
  try {
    deleteSoon(await decideRemoval(getDb(), { eventId, actor: ctx.actor, requestId, decision }));
  } catch (e) {
    return { error: errorText(t, e) };
  }
  revalidatePath(base(eventId), "layout");
  return { info: t("common.saved") };
}
