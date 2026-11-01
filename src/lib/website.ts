import { and, count, eq, gt, inArray, isNull, or } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import {
  events,
  guests,
  households,
  rateEvents,
  siteImages,
  websites,
  type Event,
  type LocalizedText,
  type SiteContent,
  type Website,
} from "@/db/schema";
import { audit, type Actor } from "./audit";
import { hmac, safeEqual } from "./crypto";
import { normalizeEmail, normalizePhone } from "./guests";
import { isUuid } from "./ids";

export class WebsiteError extends Error {
  constructor(public code: "slug_taken" | "slug_invalid" | "passcode_required" | "not_found" | "image_invalid" | "image_limit" | "too_many") {
    super(code);
  }
}

/** First path segments the app uses; wedding sites can't take these. */
export const RESERVED_SLUGS = new Set([
  "events", "account", "admin", "login", "welcome", "step-up", "dev", "offline", "g", "c", "api", "site-images",
  "manifest.webmanifest", "sw.js", "icons", "favicon.ico", "robots.txt", "sitemap.xml", "_next", "about", "help",
  "privacy", "terms", "support", "www", "app", "static",
]);

export const SITE_THEMES = ["traditional", "modern", "minimal"] as const;
export const SITE_ACCENTS = ["#8a1c2b", "#b4532a", "#9a7b2c", "#2f6b4f", "#2c5d8a", "#5b3f8c", "#3d4f7c", "#c0507d"] as const;
export const MAX_SITE_IMAGES = 30;
export const MAX_IMAGE_INPUT_BYTES = 8 * 1024 * 1024;

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " weds ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60)
    .replace(/-+$/, "");
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

const lt = (en = "", hi = ""): LocalizedText => ({ en, hi });

export function defaultContent(event: Pick<Event, "name" | "coupleNames">): SiteContent {
  const names = event.coupleNames || event.name;
  return {
    theme: "traditional",
    accent: SITE_ACCENTS[0],
    monogram: names
      .split(/\s*(?:&|and|weds|\+)\s*/i)
      .map((p) => p.trim()[0] ?? "")
      .join(" & ")
      .slice(0, 12),
    coverImageId: null,
    sections: {
      welcome: { visible: true, headline: lt(names, ""), message: lt("We can't wait to celebrate with you.", "आपके साथ जश्न मनाने का हमें बेसब्री से इंतज़ार है।") },
      story: { visible: false, title: lt("Our story", "हमारी कहानी"), body: lt(), imageIds: [] },
      events: { visible: true, title: lt("Events", "कार्यक्रम") },
      travel: { visible: false, title: lt("Travel & stay", "यात्रा और ठहराव"), body: lt() },
      faqs: { visible: false, title: lt("FAQs", "अक्सर पूछे जाने वाले सवाल"), items: [] },
      gallery: { visible: false, title: lt("Gallery", "तस्वीरें"), imageIds: [] },
      gifts: { visible: false, title: lt("Gifts", "उपहार"), body: lt("Your blessings are our gift.", "आपका आशीर्वाद ही हमारा उपहार है।") },
      contact: { visible: false, title: lt("Contact", "संपर्क"), people: [] },
    },
    order: ["welcome", "events", "story", "travel", "faqs", "gallery", "gifts", "contact"],
  };
}

const ltSchema = (max: number) => z.object({ en: z.string().max(max).optional(), hi: z.string().max(max).optional() });
const imageIds = z.array(z.string().uuid()).max(MAX_SITE_IMAGES);
const sectionKeys = ["welcome", "story", "events", "travel", "faqs", "gallery", "gifts", "contact"] as const;

export const siteContentSchema = z.object({
  theme: z.enum(SITE_THEMES),
  accent: z.enum(SITE_ACCENTS),
  monogram: z.string().trim().max(12),
  coverImageId: z.string().uuid().nullable(),
  sections: z.object({
    welcome: z.object({ visible: z.boolean(), headline: ltSchema(120), message: ltSchema(600) }),
    story: z.object({ visible: z.boolean(), title: ltSchema(80), body: ltSchema(5000), imageIds }),
    events: z.object({ visible: z.boolean(), title: ltSchema(80) }),
    travel: z.object({ visible: z.boolean(), title: ltSchema(80), body: ltSchema(5000) }),
    faqs: z.object({
      visible: z.boolean(),
      title: ltSchema(80),
      items: z.array(z.object({ q: ltSchema(200), a: ltSchema(2000) })).max(30),
    }),
    gallery: z.object({ visible: z.boolean(), title: ltSchema(80), imageIds }),
    gifts: z.object({ visible: z.boolean(), title: ltSchema(80), body: ltSchema(2000) }),
    contact: z.object({
      visible: z.boolean(),
      title: ltSchema(80),
      people: z.array(z.object({ name: z.string().trim().max(80), phone: z.string().trim().max(30) })).max(10),
    }),
  }),
  order: z
    .array(z.enum(sectionKeys))
    .length(sectionKeys.length)
    .refine((o) => new Set(o).size === o.length),
});

/** Picks the visitor's language, falling back to English when a field wasn't translated. */
export function pick(text: LocalizedText | undefined, locale: string): string {
  return (locale === "hi" ? text?.hi?.trim() || text?.en : text?.en?.trim() || text?.hi) ?? "";
}

// ---------------------------------------------------------------------------
// Website record
// ---------------------------------------------------------------------------

async function uniqueSlug(db: Tx, base: string): Promise<string> {
  const root = isValidSlug(base) ? base : `wedding-${base}`.slice(0, 60).replace(/-+$/, "");
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root.slice(0, 55)}-${i + 1}`;
    if (!isValidSlug(candidate)) continue;
    const [taken] = await db.select({ id: websites.id }).from(websites).where(eq(websites.slug, candidate));
    if (!taken) return candidate;
  }
  return `wedding-${crypto.randomUUID().slice(0, 8)}`;
}

export async function getWebsite(db: Tx, eventId: string): Promise<Website | null> {
  const [site] = await db.select().from(websites).where(eq(websites.eventId, eventId));
  return site ?? null;
}

export async function getOrCreateWebsite(db: Tx, event: Event): Promise<Website> {
  const existing = await getWebsite(db, event.id);
  if (existing) return existing;
  const slug = await uniqueSlug(db, slugify(event.coupleNames || event.name) || "wedding");
  const [site] = await db
    .insert(websites)
    .values({ eventId: event.id, slug, draft: defaultContent(event) })
    .onConflictDoNothing()
    .returning();
  return site ?? (await getWebsite(db, event.id))!;
}

export async function saveDraft(db: Tx, eventId: string, content: SiteContent) {
  const parsed = siteContentSchema.parse(content);
  await db.update(websites).set({ draft: parsed, updatedAt: new Date() }).where(eq(websites.eventId, eventId));
}

export async function setSlug(db: Tx, eventId: string, raw: string) {
  const slug = raw.trim().toLowerCase();
  if (!isValidSlug(slug)) throw new WebsiteError("slug_invalid");
  const [taken] = await db.select({ eventId: websites.eventId }).from(websites).where(eq(websites.slug, slug));
  if (taken && taken.eventId !== eventId) throw new WebsiteError("slug_taken");
  await db.update(websites).set({ slug, updatedAt: new Date() }).where(eq(websites.eventId, eventId));
}

const passcodeHash = (websiteId: string, passcode: string) => hmac(`site-passcode:${websiteId}:${passcode.trim().toLowerCase()}`);

export async function setVisibility(db: Tx, site: Website, visibility: Website["visibility"], passcode?: string) {
  if (visibility === "passcode") {
    const code = passcode?.trim() ?? "";
    if (!code && !site.passcodeHash) throw new WebsiteError("passcode_required");
    if (code && (code.length < 4 || code.length > 40)) throw new WebsiteError("passcode_required");
    await db
      .update(websites)
      .set({
        visibility,
        ...(code ? { passcodeHash: passcodeHash(site.id, code), passcodeVersion: site.passcodeVersion + 1 } : {}),
        updatedAt: new Date(),
      })
      .where(eq(websites.id, site.id));
  } else {
    await db.update(websites).set({ visibility, updatedAt: new Date() }).where(eq(websites.id, site.id));
  }
}

export function checkPasscode(site: Website, input: string): boolean {
  return !!site.passcodeHash && safeEqual(site.passcodeHash, passcodeHash(site.id, input));
}

/** Value of the cookie that remembers a correct passcode; changes when the passcode does. */
export function passcodeCookieValue(site: Pick<Website, "id" | "passcodeVersion">): string {
  return hmac(`site-unlocked:${site.id}:${site.passcodeVersion}`);
}

export async function publish(db: Database, site: Website, actor: Actor) {
  await db.transaction(async (tx) => {
    await tx.update(websites).set({ published: site.draft, publishedAt: new Date(), publishedBy: actor.userId }).where(eq(websites.id, site.id));
    await audit(tx, { eventId: site.eventId, actor, action: "website.published", entityType: "website", entityId: site.id, data: { slug: site.slug } });
  });
}

export async function unpublish(db: Database, site: Website, actor: Actor) {
  await db.transaction(async (tx) => {
    await tx.update(websites).set({ published: null, publishedAt: null }).where(eq(websites.id, site.id));
    await audit(tx, { eventId: site.eventId, actor, action: "website.unpublished", entityType: "website", entityId: site.id, data: { slug: site.slug } });
  });
}

export async function getSiteBySlug(db: Tx, slug: string) {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return null;
  const [row] = await db
    .select({ website: websites, event: events })
    .from(websites)
    .innerJoin(events, eq(events.id, websites.eventId))
    .where(and(eq(websites.slug, slug), isNull(events.deletedAt)));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Images (stored in Postgres, resized to WebP)
// ---------------------------------------------------------------------------

export async function saveSiteImage(db: Tx, eventId: string, input: ArrayBuffer): Promise<string> {
  if (input.byteLength === 0 || input.byteLength > MAX_IMAGE_INPUT_BYTES) throw new WebsiteError("image_invalid");
  const [{ n }] = await db.select({ n: count() }).from(siteImages).where(eq(siteImages.eventId, eventId));
  if (n >= MAX_SITE_IMAGES * 2) throw new WebsiteError("image_limit");
  let out: { data: Buffer; info: { width: number; height: number } };
  try {
    const meta = await sharp(Buffer.from(input)).metadata();
    if (!meta.format || !["jpeg", "png", "webp", "gif", "avif", "heif"].includes(meta.format)) throw new Error("format");
    out = await sharp(Buffer.from(input), { limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new WebsiteError("image_invalid");
  }
  const [img] = await db
    .insert(siteImages)
    .values({ eventId, mime: "image/webp", width: out.info.width, height: out.info.height, bytes: out.data.length, data: out.data })
    .returning({ id: siteImages.id });
  return img.id;
}

export async function getSiteImage(db: Tx, imageId: string) {
  if (!isUuid(imageId)) return null;
  const [img] = await db.select().from(siteImages).where(eq(siteImages.id, imageId));
  return img ?? null;
}

export function contentImageIds(c: SiteContent | null | undefined): Set<string> {
  if (!c) return new Set();
  return new Set([...(c.coverImageId ? [c.coverImageId] : []), ...c.sections.story.imageIds, ...c.sections.gallery.imageIds]);
}

/** Deletes uploaded images that neither the draft nor the published site uses. */
export async function pruneImages(db: Tx, site: Website) {
  const keep = new Set([...contentImageIds(site.draft), ...contentImageIds(site.published)]);
  const all = await db.select({ id: siteImages.id }).from(siteImages).where(eq(siteImages.eventId, site.eventId));
  const drop = all.map((r) => r.id).filter((id) => !keep.has(id));
  if (drop.length) await db.delete(siteImages).where(inArray(siteImages.id, drop));
  return drop.length;
}

// ---------------------------------------------------------------------------
// Rate limiting & "find my invitation" (WEB-06)
// ---------------------------------------------------------------------------

/** Records an attempt and returns false when `limit` attempts already happened within the window. */
export async function allowAttempt(db: Tx, kind: string, key: string, limit: number, windowMs: number, now = new Date()) {
  const [{ n }] = await db
    .select({ n: count() })
    .from(rateEvents)
    .where(and(eq(rateEvents.kind, kind), eq(rateEvents.key, key), gt(rateEvents.createdAt, new Date(now.getTime() - windowMs))));
  if (n >= limit) return false;
  await db.insert(rateEvents).values({ kind, key, createdAt: now });
  return true;
}

/** The family a phone/email belongs to in this event (only families whose link isn't revoked). */
export async function findHouseholdByContact(db: Tx, eventId: string, raw: string) {
  const phone = normalizePhone(raw);
  const email = normalizeEmail(raw);
  const conds = [
    phone && phone !== "invalid" ? eq(guests.phone, phone) : undefined,
    email && email !== "invalid" ? eq(guests.email, email) : undefined,
  ].filter(Boolean);
  if (conds.length === 0) return null;
  const [row] = await db
    .select({ household: households, guest: guests })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(and(eq(guests.eventId, eventId), isNull(households.linkRevokedAt), or(...conds)))
    .limit(1);
  return row ?? null;
}
