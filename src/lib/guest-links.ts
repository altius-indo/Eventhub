import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { events, households, type Event, type Household } from "@/db/schema";
import { createTranslator, isLocale } from "@/i18n/core";
import { hmac, safeEqual } from "./crypto";
import { sendMessage, type Channel } from "./delivery";

/**
 * Guest links (GST-06): /g/<token>, where the token is the household id plus an
 * HMAC over (id, linkVersion). Nothing secret is stored; bumping linkVersion
 * invalidates every earlier link for that family.
 */
const ID_LEN = 22; // base64url of 16 bytes

function uuidToB64(id: string): string {
  return Buffer.from(id.replace(/-/g, ""), "hex").toString("base64url");
}

function b64ToUuid(b64: string): string | null {
  const buf = Buffer.from(b64, "base64url");
  if (buf.length !== 16) return null;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type TokenPurpose = "guest-link" | "checkin-pass";
const mac = (householdId: string, version: number, purpose: TokenPurpose = "guest-link") =>
  hmac(`${purpose}:${householdId}:${version}`).slice(0, 22);

export function makeGuestToken(householdId: string, version: number): string {
  return uuidToB64(householdId) + mac(householdId, version);
}

/**
 * Entry-pass token (ADR-0014): same household id and linkVersion, different HMAC purpose.
 * It identifies the family to a signed-in team member at check-in and grants nothing else.
 */
export function makePassToken(householdId: string, version: number): string {
  return uuidToB64(householdId) + mac(householdId, version, "checkin-pass");
}

export function passUrl(appUrl: string, household: Pick<Household, "id" | "linkVersion">): string {
  return `${appUrl}/c/${makePassToken(household.id, household.linkVersion)}`;
}

export function guestLinkUrl(appUrl: string, household: Pick<Household, "id" | "linkVersion">): string {
  return `${appUrl}/g/${makeGuestToken(household.id, household.linkVersion)}`;
}

/** Returns the family and event for a valid, unrevoked link; null otherwise. */
export function resolveGuestToken(db: Tx, token: string) {
  return resolveToken(db, token, "guest-link");
}

/** Resolves an entry-pass token (from /c/<token>). */
export function resolvePassToken(db: Tx, token: string) {
  return resolveToken(db, token, "checkin-pass");
}

async function resolveToken(db: Tx, token: string, purpose: TokenPurpose): Promise<{ household: Household; event: Event } | null> {
  if (!/^[A-Za-z0-9_-]{44}$/.test(token)) return null;
  const householdId = b64ToUuid(token.slice(0, ID_LEN));
  if (!householdId) return null;
  const [row] = await db
    .select({ household: households, event: events })
    .from(households)
    .innerJoin(events, eq(events.id, households.eventId))
    .where(and(eq(households.id, householdId), isNull(households.linkRevokedAt), isNull(events.deletedAt)));
  if (!row) return null;
  return safeEqual(token.slice(ID_LEN), mac(householdId, row.household.linkVersion, purpose)) ? row : null;
}

export async function regenerateGuestLink(db: Tx, eventId: string, householdId: string) {
  const [h] = await db
    .update(households)
    .set({ linkVersion: sql`${households.linkVersion} + 1`, linkRevokedAt: null, updatedAt: new Date() })
    .where(and(eq(households.id, householdId), eq(households.eventId, eventId)))
    .returning();
  return h ?? null;
}

export async function revokeGuestLink(db: Tx, eventId: string, householdId: string) {
  const [h] = await db
    .update(households)
    .set({ linkRevokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(households.id, householdId), eq(households.eventId, eventId)))
    .returning();
  return h ?? null;
}

export function guestLinkMessage(locale: string, eventName: string, householdName: string, url: string): string {
  const t = createTranslator(isLocale(locale) ? locale : "en");
  return t("guestLink.message", { event: eventName, family: householdName, url });
}

/** Sends a family their link by SMS/WhatsApp/email through the configured provider. */
export async function sendGuestLink(
  db: Tx,
  input: { household: Household; event: Pick<Event, "name">; channel: Channel; to: string; appUrl: string },
) {
  const url = guestLinkUrl(input.appUrl, input.household);
  await sendMessage(db, {
    channel: input.channel,
    to: input.to,
    subject: input.event.name,
    text: guestLinkMessage(input.household.locale, input.event.name, input.household.name, url),
  });
  await db.update(households).set({ linkSentAt: new Date() }).where(eq(households.id, input.household.id));
}

/** A wa.me link that opens WhatsApp with the invitation text pre-filled (no API needed). */
export function whatsappShareUrl(phone: string | null, text: string): string {
  const digits = phone?.replace(/\D/g, "") ?? "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
