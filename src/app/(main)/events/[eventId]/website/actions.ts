"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { SiteContent } from "@/db/schema";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { parseSiteForm } from "@/lib/server/site-form";
import {
  getOrCreateWebsite,
  MAX_SITE_IMAGES,
  pruneImages,
  publish,
  saveDraft,
  saveSiteImage,
  setSlug,
  setVisibility,
  unpublish,
  WebsiteError,
} from "@/lib/website";

type State = { error?: string; info?: string };

async function editorContext(eventId: string) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("website.edit")) redirect(`/events/${eventId}`);
  const site = await getOrCreateWebsite(getDb(), ctx.event);
  return { ctx, site };
}

function done(eventId: string, query: string): never {
  revalidatePath(`/events/${eventId}/website`);
  redirect(`/events/${eventId}/website?${query}`);
}

/** Saves whatever is in the editor form, then returns the new content. */
async function saveFromForm(eventId: string, formData: FormData): Promise<SiteContent> {
  const { site } = await editorContext(eventId);
  const content = parseSiteForm(formData, site.draft);
  try {
    await saveDraft(getDb(), eventId, content);
  } catch {
    done(eventId, "error=not_found");
  }
  return content;
}

export async function saveDraftAction(eventId: string, formData: FormData) {
  await saveFromForm(eventId, formData);
  done(eventId, "saved=1");
}

export async function uploadImageAction(eventId: string, target: "cover" | "story" | "gallery", formData: FormData) {
  const content = await saveFromForm(eventId, formData);
  const file = formData.get(`file.${target}`);
  if (!(file instanceof File) || file.size === 0) done(eventId, "error=image_invalid");
  const list = target === "story" ? content.sections.story.imageIds : target === "gallery" ? content.sections.gallery.imageIds : null;
  if (list && list.length >= MAX_SITE_IMAGES) done(eventId, "error=image_limit");
  let id: string;
  try {
    id = await saveSiteImage(getDb(), eventId, await file.arrayBuffer());
  } catch (err) {
    if (err instanceof WebsiteError) done(eventId, `error=${err.code}`);
    throw err;
  }
  if (target === "cover") content.coverImageId = id;
  else if (list) list.push(id);
  await saveDraft(getDb(), eventId, content);
  done(eventId, `saved=1#${target}`);
}

export async function removeImageAction(eventId: string, id: string, formData: FormData) {
  const content = await saveFromForm(eventId, formData);
  if (content.coverImageId === id) content.coverImageId = null;
  content.sections.story.imageIds = content.sections.story.imageIds.filter((x) => x !== id);
  content.sections.gallery.imageIds = content.sections.gallery.imageIds.filter((x) => x !== id);
  await saveDraft(getDb(), eventId, content);
  const { site } = await editorContext(eventId);
  await pruneImages(getDb(), site);
  done(eventId, "saved=1");
}

export async function moveSectionAction(eventId: string, key: string, dir: "up" | "down", formData: FormData) {
  const content = await saveFromForm(eventId, formData);
  const i = content.order.indexOf(key as SiteContent["order"][number]);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < content.order.length) {
    [content.order[i], content.order[j]] = [content.order[j], content.order[i]];
    await saveDraft(getDb(), eventId, content);
  }
  done(eventId, `saved=1#section-${key}`);
}

export async function publishAction(eventId: string) {
  const { ctx, site } = await editorContext(eventId);
  if (!ctx.can("website.publish")) done(eventId, "error=not_found");
  await publish(getDb(), site, ctx.actor);
  await pruneImages(getDb(), { ...site, published: site.draft });
  done(eventId, "published=1");
}

export async function unpublishAction(eventId: string) {
  const { ctx, site } = await editorContext(eventId);
  if (!ctx.can("website.publish")) done(eventId, "error=not_found");
  await unpublish(getDb(), site, ctx.actor);
  done(eventId, "saved=1");
}

export async function slugAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  await editorContext(eventId);
  const { t } = await getTranslator();
  try {
    await setSlug(getDb(), eventId, String(formData.get("slug") ?? ""));
  } catch (err) {
    if (err instanceof WebsiteError) return { error: t(`websiteEditor.errors.${err.code}`) };
    throw err;
  }
  revalidatePath(`/events/${eventId}/website`);
  return { info: t("common.saved") };
}

export async function visibilityAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const { site } = await editorContext(eventId);
  const { t } = await getTranslator();
  const v = String(formData.get("visibility"));
  if (v !== "unlisted" && v !== "passcode" && v !== "public") return { error: t("common.somethingWrong") };
  try {
    await setVisibility(getDb(), site, v, String(formData.get("passcode") ?? ""));
  } catch (err) {
    if (err instanceof WebsiteError) return { error: t(`websiteEditor.errors.${err.code}`) };
    throw err;
  }
  revalidatePath(`/events/${eventId}/website`);
  return { info: t("common.saved") };
}
