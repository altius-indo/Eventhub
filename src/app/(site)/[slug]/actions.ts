"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import type { Diet, RsvpStatus } from "@/db/schema";
import { createTranslator, isLocale, LOCALE_COOKIE } from "@/i18n/core";
import { DeliveryError } from "@/lib/delivery";
import { sendGuestLink } from "@/lib/guest-links";
import { addPlusOne, getPortalData, removePlusOne, RsvpError, saveRsvps } from "@/lib/rsvp";
import { appUrl } from "@/lib/server/session";
import { getSiteContext, siteCookieName } from "@/lib/server/site-context";
import { saveTravel, travelFromForm } from "@/lib/travel";
import { allowAttempt, checkPasscode, findHouseholdByContact, passcodeCookieValue } from "@/lib/website";

type State = { error?: string; info?: string };

async function guestContext(slug: string) {
  const ctx = await getSiteContext(slug);
  if (!ctx?.guest) redirect(`/${slug}`);
  const locale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const t = createTranslator(isLocale(locale) ? locale : isLocale(ctx.guest.household.locale) ? ctx.guest.household.locale : "en");
  return { ...ctx, guest: ctx.guest, t };
}

async function clientIp() {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

const DIETS: Diet[] = ["veg", "non_veg", "jain", "vegan", "other"];

/** The family's replies: radio names "r:<guestId>:<functionId>", food "diet:<guestId>" and "notes:<guestId>". */
export async function guestRsvpAction(slug: string, _prev: State, formData: FormData): Promise<State> {
  const { event, guest, t } = await guestContext(slug);
  const answers: { guestId: string; functionId: string; status: RsvpStatus | null }[] = [];
  const diets: { guestId: string; diet: Diet | null; dietNotes: string | null }[] = [];
  for (const [k, v] of formData.entries()) {
    const r = k.match(/^r:([0-9a-f-]{36}):([0-9a-f-]{36})$/i);
    if (r && (v === "attending" || v === "maybe" || v === "declined")) answers.push({ guestId: r[1], functionId: r[2], status: v });
    const d = k.match(/^diet:([0-9a-f-]{36})$/i);
    if (d) {
      diets.push({
        guestId: d[1],
        diet: DIETS.includes(v as Diet) ? (v as Diet) : null,
        dietNotes: String(formData.get(`notes:${d[1]}`) ?? "").trim().slice(0, 200) || null,
      });
    }
  }
  try {
    await saveRsvps(getDb(), { household: guest.household, event, answers, diets, recordedBy: null });
  } catch (err) {
    if (err instanceof RsvpError) return { error: t(`rsvp.errors.${err.code}`) };
    throw err;
  }
  revalidatePath(`/${slug}`);
  return { info: t("rsvp.saved") };
}

export async function addPlusOneAction(slug: string, _prev: State, formData: FormData): Promise<State> {
  const { event, guest, t } = await guestContext(slug);
  const portal = await getPortalData(getDb(), guest.household);
  const head = portal.members.find((m) => m.isHead) ?? portal.members[0];
  const age = formData.get("ageGroup");
  try {
    await addPlusOne(getDb(), {
      household: guest.household,
      event,
      name: String(formData.get("name") ?? ""),
      ageGroup: age === "child" || age === "infant" ? age : "adult",
      invitedWithId: String(formData.get("invitedWithId") || head.id),
      byGuest: true,
    });
  } catch (err) {
    if (err instanceof RsvpError) return { error: t(`rsvp.errors.${err.code}`) };
    throw err;
  }
  revalidatePath(`/${slug}`);
  return { info: t("common.saved") };
}

export async function removePlusOneAction(slug: string, guestId: string) {
  const { event, guest } = await guestContext(slug);
  try {
    await removePlusOne(getDb(), { household: guest.household, event, guestId, byGuest: true });
  } catch (err) {
    if (!(err instanceof RsvpError)) throw err;
  }
  revalidatePath(`/${slug}`);
}

export async function guestTravelAction(slug: string, guestId: string, _prev: State, formData: FormData): Promise<State> {
  const { guest, t } = await guestContext(slug);
  const portal = await getPortalData(getDb(), guest.household);
  if (!portal.members.some((m) => m.id === guestId)) return { error: t("rsvp.errors.not_found") };
  const parsed = travelFromForm(formData);
  if (!parsed.success) return { error: t("travel.order") };
  const targets = formData.get("copyToAll") === "on" ? portal.members.map((m) => m.id) : [guestId];
  for (const id of targets) await saveTravel(getDb(), id, parsed.data, true);
  revalidatePath(`/${slug}`);
  return { info: t("common.saved") };
}

/**
 * "Find my invitation" (WEB-06). Always answers the same way so the guest list
 * can't be probed; the link goes only to the matched phone/email.
 */
export async function findInvitationAction(slug: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await getSiteContext(slug);
  if (!ctx) return {};
  const t = createTranslator(isLocale(formData.get("lang")) ? (formData.get("lang") as "en" | "hi") : "en");
  const raw = String(formData.get("contact") ?? "").trim().slice(0, 100);
  if (!raw) return { error: t("site.findInput") };
  const db = getDb();
  const ip = await clientIp();
  if (!(await allowAttempt(db, "find-invite:ip", ip, 10, 60 * 60 * 1000)) || !(await allowAttempt(db, "find-invite:contact", `${ctx.event.id}:${raw.toLowerCase()}`, 3, 60 * 60 * 1000))) {
    return { error: t("site.findLimited") };
  }
  const match = await findHouseholdByContact(db, ctx.event.id, raw);
  if (match) {
    const isEmail = raw.includes("@");
    try {
      await sendGuestLink(db, {
        household: match.household,
        event: ctx.event,
        channel: isEmail ? "email" : "sms",
        to: (isEmail ? match.guest.email : match.guest.phone)!,
        appUrl: appUrl(),
      });
    } catch (err) {
      if (!(err instanceof DeliveryError)) throw err;
      console.error("find-invitation delivery failed", err);
    }
  }
  return { info: t("site.findSent") };
}

export async function unlockAction(slug: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await getSiteContext(slug);
  if (!ctx) return {};
  const t = createTranslator(isLocale(formData.get("lang")) ? (formData.get("lang") as "en" | "hi") : "en");
  if (!(await allowAttempt(getDb(), "passcode", `${ctx.website.id}:${await clientIp()}`, 10, 15 * 60 * 1000))) {
    return { error: t("websiteEditor.errors.too_many") };
  }
  if (!checkPasscode(ctx.website, String(formData.get("passcode") ?? ""))) return { error: t("site.passcodeWrong") };
  (await cookies()).set(siteCookieName(ctx.website.id), passcodeCookieValue(ctx.website), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/`,
    maxAge: 90 * 24 * 60 * 60,
  });
  redirect(`/${slug}`);
}

export async function setSiteLanguageAction(slug: string, formData: FormData) {
  const lang = formData.get("lang");
  if (isLocale(lang)) (await cookies()).set(LOCALE_COOKIE, lang, { path: "/", maxAge: 365 * 24 * 60 * 60, sameSite: "lax" });
  redirect(`/${slug}${formData.get("preview") ? "?preview=1" : ""}`);
}
