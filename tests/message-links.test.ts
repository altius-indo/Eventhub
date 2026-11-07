import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvalRequests,
  devOutbox,
  eventLimitOverrides,
  eventStorageOverrides,
  events,
  functionInvites,
  guests,
  households,
  notifications,
  outboundMessages,
  paymentMilestones,
  users,
  vendorContacts,
} from "@/db/schema";
import { isLocale, type Locale } from "@/i18n/core";
import "@/lib/approval-handlers";
import "@/lib/templates";
import { linkBase, resolveAppUrl } from "@/lib/app-url";
import { decideRequest } from "@/lib/approvals";
import { proposeBooking } from "@/lib/bookings";
import { createDraft, readUnsubscribeToken, sendBroadcast } from "@/lib/broadcasts";
import { getCatererView, checkHeadcountAlerts, setHeadcountLock } from "@/lib/caterer-headcount";
import { listServiceTypes } from "@/lib/catalogue";
import { postMessage, type ChatViewer } from "@/lib/chat";
import { createEvent, inviteMember } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import {
  addToSelection,
  beginUpload,
  completeUpload,
  createAlbum,
  createSelection,
  photoBookings,
  releaseAlbum,
  requestRemoval,
  shareSelection,
  toggleFavourite,
  type Uploader,
} from "@/lib/gallery";
import { createGiftItem, sendGiftReminders, type GiftCtx } from "@/lib/gifts";
import { resolveGuestToken, sendGuestLink } from "@/lib/guest-links";
import { renderNotification } from "@/lib/notifications";
import { requestOtp } from "@/lib/otp";
import { processOutbox } from "@/lib/outbox";
import { requestPasswordReset } from "@/lib/passwords";
import { sendApprovalReminders, sendPaymentReminders } from "@/lib/payments";
import type { PolicySubject } from "@/lib/policy";
import { createQuoteRequests, getQuote, saveQuote, type QuoteInput } from "@/lib/quotes";
import { processRenditions } from "@/lib/renditions";
import { sendRetentionReminders } from "@/lib/retention";
import { saveRsvps, sendRsvpReminders } from "@/lib/rsvp";
import { addRequirement, addService } from "@/lib/services";
import { FsStore, setStoreForTests } from "@/lib/storage";
import { commit, reserve } from "@/lib/storage-quota";
import { createTask, sendTaskReminders, taskSchema } from "@/lib/tasks";
import { saveDraft, saveTemplate, sendThankYous, sendThankYouReminders } from "@/lib/thank-yous";
import { inviteVendorContact } from "@/lib/vendor-access";
import { submitPortalQuote, uploadPortalInvoice } from "@/lib/vendor-portal";
import { createVendor } from "@/lib/vendors";
import { findHouseholdByContact } from "@/lib/website";
import { actorOf, db, makeUser, outbox, resetDb } from "./helpers";

/**
 * Every outgoing message (email, SMS, WhatsApp) and in-app notification, triggered through the
 * real domain code with APP_URL set to a production-like domain. Each message must carry only
 * absolute links on that domain, to pages that exist, with every placeholder filled.
 */

const BASE = "https://eventhub.example.org";
const ENV_KEYS = ["APP_URL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
}

let root: string;
let store: FsStore;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  root = await mkdtemp(path.join(tmpdir(), "eh-links-"));
  store = new FsStore(root);
  setStoreForTests(store);
});
afterAll(async () => {
  setEnv(savedEnv);
  setStoreForTests(null);
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  setEnv({ APP_URL: BASE });
  await resetDb();
  checked = 0;
});

// ---------------------------------------------------------------------------
// Routes under src/app, to prove each link opens a page that exists
// ---------------------------------------------------------------------------

const APP_DIR = path.join(__dirname, "..", "src", "app");

function collectRoutes(dir: string, segs: string[] = []): RegExp[] {
  const out: RegExp[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Route groups "(main)" don't appear in the URL.
      const next = /^\(.*\)$/.test(entry.name) ? segs : [...segs, entry.name];
      out.push(...collectRoutes(path.join(dir, entry.name), next));
    } else if (/^(page\.tsx|route\.ts)$/.test(entry.name)) {
      const pattern = segs
        .map((s) => (/^\[\.\.\..+\]$/.test(s) ? ".+" : /^\[.+\]$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/");
      out.push(new RegExp(`^/${pattern}$`));
    }
  }
  return out;
}
const ROUTES = collectRoutes(APP_DIR);
const routeExists = (pathname: string) => ROUTES.some((r) => r.test(pathname.replace(/\/$/, "") || "/"));

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"'()]+/g;
/** A path shown as if it were a link (" /events/…", ": /login"), i.e. a missing base URL. */
const BARE_PATH = /(^|[\s:(])\/(events|g|c|u|login|vendor|account|notifications|admin|welcome)(\/|\b)/m;

function checkText(label: string, text: string): string[] {
  expect(text, label).not.toMatch(/localhost|127\.0\.0\.1/i);
  expect(text, label).not.toMatch(/\bundefined\b/);
  expect(text, label).not.toMatch(/\bnull\b/);
  expect(text, label).not.toMatch(/\{[a-zA-Z]+\}/);
  expect(text, label).not.toContain("[object Object]");
  expect(text, `${label}: relative link`).not.toMatch(BARE_PATH);
  const urls = text.match(URL_RE) ?? [];
  for (const u of urls) {
    expect(u.startsWith(`${BASE}/`), `${label}: ${u} is not on ${BASE}`).toBe(true);
    const p = new URL(u).pathname;
    expect(routeExists(p), `${label}: no page for ${p}`).toBe(true);
  }
  return urls;
}

/** SMS segments: GSM-7 160/153 chars, otherwise UCS-2 (e.g. Hindi, curly quotes) 70/67. */
function smsSegments(text: string) {
  const gsm = /^[A-Za-z0-9 \n\r@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/.test(text);
  const len = gsm ? [...text].reduce((n, ch) => n + ("^{}\\[~]|€".includes(ch) ? 2 : 1), 0) : [...text].length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { gsm, segments: len <= single ? 1 : Math.ceil(len / multi) };
}

type OutboxRow = typeof devOutbox.$inferSelect;
let checked = 0;
const sms: { name: string; locale: string; segments: number; gsm: boolean }[] = [];

/** Sends anything queued, then returns (and generically checks) messages not seen before. */
async function fresh(): Promise<OutboxRow[]> {
  await processOutbox(db());
  const rows = await outbox();
  const out = rows.slice(checked);
  checked = rows.length;
  for (const m of out) checkMessage(m);
  return out;
}

function checkMessage(m: OutboxRow): string[] {
  const label = `${m.channel} to ${m.to} "${m.subject ?? ""}"`;
  if (m.channel === "email") {
    expect(m.subject?.trim(), `${label}: email without subject`).toBeTruthy();
    checkText(`${label} [subject]`, m.subject ?? "");
  }
  return checkText(label, m.body);
}

function expectLink(m: OutboxRow | undefined, pathRe: RegExp): string {
  expect(m, `no message for ${pathRe}`).toBeDefined();
  const urls = checkMessage(m!).map((u) => u.slice(BASE.length));
  const hit = urls.find((u) => pathRe.test(u));
  expect(hit, `${m!.channel} to ${m!.to}: expected a link matching ${pathRe}, got ${urls.join(", ") || "none"}\n${m!.body}`).toBeDefined();
  return hit!;
}

function recordSms(name: string, locale: string, m: OutboxRow) {
  if (m.channel === "email") return;
  // The test event's name has an en dash (non-GSM); measure the template, not our sample data.
  const s = smsSegments(m.body.replaceAll(EVENT_NAME, EVENT_NAME.replace("–", "-")));
  sms.push({ name, locale, ...s });
  // Templates we write ourselves stay within ~3 SMS (GSM-7) / 5 (Hindi, Unicode) when sent by SMS.
  expect(s.segments, `${name} (${locale}) is ${s.segments} SMS segments:\n${m.body}`).toBeLessThanOrEqual(s.gsm ? 3 : 5);
}

const isDevanagari = (s: string) => /[ऀ-ॿ]/.test(s);

const kindsSeen = new Set<string>();

/** Checks every notification row (both languages) and the email copy queued for it. */
async function checkNotifications() {
  const rows = await db().select().from(notifications);
  for (const n of rows) {
    kindsSeen.add(n.kind);
    for (const locale of ["en", "hi"] as Locale[]) {
      const text = renderNotification(locale, n);
      expect(text, `${n.kind} has no ${locale} text`).not.toBe(n.kind);
      checkText(`notification ${n.kind} (${locale})`, text);
      expect(text.match(URL_RE), `${n.kind}: in-app text carries no URL`).toBeNull();
    }
    if (n.href) {
      // Relative by design (in-app navigation, safeNext); the email copy adds the base.
      expect(n.href, n.kind).toMatch(/^\/[^/\\]/);
      expect(routeExists(n.href.split(/[?#]/)[0]), `${n.kind}: no page for ${n.href}`).toBe(true);
    }
  }
  const queued = await db().select().from(outboundMessages).where(eq(outboundMessages.purpose, "notification"));
  for (const q of queued) {
    const n = rows.find((r) => q.idempotencyKey === `n:${r.id}`);
    if (!n) continue;
    const text = String(q.vars.text);
    const locale: Locale = isLocale(q.locale) ? q.locale : "en";
    expect(text.startsWith(renderNotification(locale, n)), `${n.kind}: email text in the reader's language`).toBe(true);
    if (n.href) expect(text.endsWith(`\n${BASE}${n.href}`), `${n.kind}: email link must be absolute:\n${text}`).toBe(true);
    else expect(text.match(URL_RE)).toBeNull();
  }
  return rows;
}

// ---------------------------------------------------------------------------
// A wedding to send from
// ---------------------------------------------------------------------------

const hostS: PolicySubject = { isAppAdmin: false, membership: { role: "host", giftAccess: "none" } };
const plannerS: PolicySubject = { isAppAdmin: false, membership: { role: "planner", giftAccess: "none" } };
const blank = { startTime: "19:00", endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const TODAY = "2026-11-01";
const EVENT_NAME = "Sharma–Verma Wedding";
const COUPLE = "Priya & Arjun";

async function world() {
  const host = await makeUser("host@example.com", "Asha");
  const actor = actorOf(host);
  const event = await createEvent(db(), actor, { name: EVENT_NAME, coupleNames: COUPLE, startDate: "2026-12-09" });
  const H = { eventId: event.id, actor, subject: hostS };
  const mehendi = await createFunction(db(), event.id, actor, { name: "Mehendi", date: "2026-12-09", ...blank });
  const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", date: "2026-12-10", ...blank });
  const types = await listServiceTypes(db(), event.id);

  /** A family with one head (phone and/or email), invited to the given functions. */
  async function family(name: string, locale: "en" | "hi", contact: { phone?: string; email?: string }, fnIds: string[]) {
    const [h] = await db().insert(households).values({ eventId: event.id, name, side: "bride", locale }).returning();
    const [g] = await db()
      .insert(guests)
      .values({ eventId: event.id, householdId: h.id, name: `${name} head`, isHead: true, phone: contact.phone ?? null, email: contact.email ?? null })
      .returning();
    if (fnIds.length) await db().insert(functionInvites).values(fnIds.map((functionId) => ({ functionId, guestId: g.id })));
    return { household: h, guest: g };
  }

  /** A Host-confirmed booking of a vendor (with a portal login) on a new service of `typeKey`. */
  async function book(name: string, contact: string, typeKey: string, fnId: string) {
    const type = types.find((t) => t.systemKey === typeKey)!;
    const svc = (await addService(db(), H, { functionId: fnId, serviceTypeId: type.id, useTemplates: false, ownerUserId: host.id })).service;
    const req = (
      await addRequirement(db(), H, svc.id, { title: "Coverage", quantity: 1, unit: null, specs: null, startsAt: null, endsAt: null, venue: null, estimatePaise: 1_00_000_00, priority: "must", payer: null })
    ).requirement;
    const vendor = await createVendor(db(), event.id, actor, { name, contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [type.id] });
    await inviteVendorContact(db(), { eventId: event.id, vendorId: vendor.id, identifier: { type: "email", value: contact }, actor, appUrl: resolveAppUrl() });
    const user = await makeUser(contact, name);
    const [requestId] = await createQuoteRequests(db(), event.id, actor, { vendorIds: [vendor.id], serviceIds: [svc.id], dueDate: null, message: null });
    const q = await saveQuote(db(), event.id, actor, { requestId }, quoteFor(req));
    const v = await getQuote(db(), event.id, q.id);
    const b = await proposeBooking(db(), H, { quoteId: q.id, lineIds: [v.lines[0].id], today: TODAY });
    return { vendor, user, booking: b.booking, svc, req };
  }

  return { host, actor, event, H, mehendi, sangeet, types, family, book };
}

const quoteFor = (req: { id: string; serviceId: string }, amount = 1_00_000_00): QuoteInput => ({
  vendorRef: null,
  receivedOn: TODAY,
  validUntil: null,
  terms: null,
  taxType: "none",
  allOrNothing: false,
  minFunctions: null,
  lines: [{ scope: "requirement", serviceId: req.serviceId, requirementId: req.id, description: null, quantity: null, amountPaise: amount, gstRateBps: 0, conditional: false, allocation: null }],
});

const GUEST_LINK = /^\/g\/[A-Za-z0-9_-]{44}$/;

async function expectOwnGuestLink(link: string, householdId: string) {
  const token = link.split("?")[0].slice("/g/".length);
  const resolved = await resolveGuestToken(db(), token);
  expect(resolved?.household.id, "guest link opens the right family").toBe(householdId);
}

// ---------------------------------------------------------------------------
// Logins, invitations, guest links
// ---------------------------------------------------------------------------

describe("sign-in and invitation messages", () => {
  it("login codes (email + WhatsApp, en + hi): no links, no placeholders", async () => {
    expect((await requestOtp(db(), { purpose: "login", identifier: { type: "email", value: "a@example.com" }, locale: "en" })).ok).toBe(true);
    expect((await requestOtp(db(), { purpose: "login", identifier: { type: "phone", value: "+919876500010" }, phoneChannel: "whatsapp", locale: "hi" })).ok).toBe(true);
    expect((await requestOtp(db(), { purpose: "step_up", identifier: { type: "phone", value: "+919876500011" }, locale: "en" })).ok).toBe(true);
    const [mail, wa, step] = await fresh();
    expect(mail.body).toMatch(/\b\d{6}\b/);
    expect(isDevanagari(wa.body)).toBe(true);
    for (const [m, name] of [[wa, "otp.login"], [step, "otp.stepUp"]] as const) recordSms(name, m === wa ? "hi" : "en", m);
    expect(mail.body.match(URL_RE)).toBeNull();
  });

  it("member invite (email en, SMS hi) links to /login and names the event", async () => {
    const w = await world();
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "email", value: "planner@example.com" }, role: "planner", locale: "en", appUrl: resolveAppUrl() });
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "phone", value: "+919876500020" }, role: "host", locale: "hi", appUrl: resolveAppUrl() });
    const [email, text] = await fresh();
    expect(expectLink(email, /^\/login$/)).toBe("/login");
    expect(email.subject).toContain(EVENT_NAME);
    expect(email.body).toContain(EVENT_NAME);
    expect(expectLink(text, /^\/login$/)).toBe("/login");
    expect(isDevanagari(text.body)).toBe(true);
    expect(text.body).toContain(EVENT_NAME);
    recordSms("members.inviteMessage", "hi", text);
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "phone", value: "+919876500021" }, role: "planner", locale: "en", appUrl: resolveAppUrl() });
    const [enText] = await fresh();
    expectLink(enText, /^\/login$/);
    recordSms("members.inviteMessage", "en", enText);
  });

  it("App Admin password reset links to /login/reset/<token>", async () => {
    await makeUser("admin@example.com", "Admin");
    await requestPasswordReset(db(), { email: "admin@example.com", appUrl: resolveAppUrl(), locale: "en" });
    const [m] = await fresh();
    expectLink(m, /^\/login\/reset\/[A-Za-z0-9_-]{20,100}$/);
  });

  it("guest link (staff send, en + hi) and find-my-invitation link to the family's own /g/<token>", async () => {
    const w = await world();
    const en = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, [w.mehendi.id]);
    const hi = await w.family("Sharma", "hi", { phone: "+919876500030" }, [w.mehendi.id]);
    await sendGuestLink(db(), { household: en.household, event: w.event, channel: "email", to: "kapoor@example.com", appUrl: resolveAppUrl() });
    await sendGuestLink(db(), { household: hi.household, event: w.event, channel: "sms", to: "+919876500030", appUrl: resolveAppUrl() });
    // "Find my invitation" (site action): look up by the contact typed in, send to that contact.
    const match = await findHouseholdByContact(db(), w.event.id, "+91 98765 00030");
    expect(match?.household.id).toBe(hi.household.id);
    await sendGuestLink(db(), { household: match!.household, event: w.event, channel: "sms", to: match!.guest.phone!, appUrl: resolveAppUrl() });
    const [mail, sms1, sms2] = await fresh();
    await expectOwnGuestLink(expectLink(mail, GUEST_LINK), en.household.id);
    expect(mail.subject).toBe(EVENT_NAME);
    await expectOwnGuestLink(expectLink(sms1, GUEST_LINK), hi.household.id);
    await expectOwnGuestLink(expectLink(sms2, GUEST_LINK), hi.household.id);
    expect(isDevanagari(sms1.body)).toBe(true);
    expect(mail.body).toMatch(/You're invited/);
    recordSms("guestLink.message", "hi", sms1);
    const mehta = await w.family("Mehta", "en", { phone: "+919876500031" }, [w.mehendi.id]);
    await sendGuestLink(db(), { household: mehta.household, event: w.event, channel: "sms", to: "+919876500031", appUrl: resolveAppUrl() });
    const [enSms] = await fresh();
    await expectOwnGuestLink(expectLink(enSms, GUEST_LINK), mehta.household.id);
    recordSms("guestLink.message", "en", enSms);
  });

  it("vendor portal invites (email + SMS) link to /vendor and name the event", async () => {
    const w = await world();
    const vendor = await createVendor(db(), w.event.id, w.actor, { name: "Spice", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    await inviteVendorContact(db(), { eventId: w.event.id, vendorId: vendor.id, identifier: { type: "email", value: "chef@spice.in" }, actor: w.actor, appUrl: resolveAppUrl() });
    await inviteVendorContact(db(), { eventId: w.event.id, vendorId: vendor.id, identifier: { type: "phone", value: "+919876500040" }, actor: w.actor, appUrl: resolveAppUrl() });
    const msgs = await fresh();
    const mail = msgs.find((m) => m.to === "chef@spice.in")!;
    const text = msgs.find((m) => m.to === "+919876500040")!;
    expect(text.channel).toBe("sms");
    expectLink(mail, /^\/vendor$/);
    expect(mail.subject).toContain(EVENT_NAME);
    expectLink(text, /^\/vendor$/);
    recordSms("vendorPortal.inviteText", "en", text);
  });

  it("an empty appUrl from a caller still gives absolute links (never bare paths)", async () => {
    const w = await world();
    const fam = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, []);
    const vendor = await createVendor(db(), w.event.id, w.actor, { name: "Spice", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "email", value: "p@example.com" }, role: "planner", locale: "en", appUrl: "" });
    await inviteVendorContact(db(), { eventId: w.event.id, vendorId: vendor.id, identifier: { type: "email", value: "chef@spice.in" }, actor: w.actor, appUrl: "" });
    await sendGuestLink(db(), { household: fam.household, event: w.event, channel: "email", to: "kapoor@example.com", appUrl: "" });
    await makeUser("admin@example.com", "Admin");
    await requestPasswordReset(db(), { email: "admin@example.com", appUrl: "", locale: "en" });
    const msgs = await fresh();
    expect(msgs).toHaveLength(4);
    expectLink(msgs.find((m) => m.to === "p@example.com"), /^\/login$/);
    expectLink(msgs.find((m) => m.to === "chef@spice.in"), /^\/vendor$/);
    expectLink(msgs.find((m) => m.to === "kapoor@example.com"), GUEST_LINK);
    expectLink(msgs.find((m) => m.to === "admin@example.com"), /^\/login\/reset\//);
    expect(linkBase("https://x.example/")).toBe("https://x.example");
    expect(linkBase(" ")).toBe(BASE);
  });

  it("on a Vercel preview without APP_URL, the member invite uses the branch URL (never localhost)", async () => {
    const w = await world();
    setEnv({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "eventhub-git-fix-links-acme.vercel.app", VERCEL_URL: "eventhub-abc123-acme.vercel.app" });
    const branch = "https://eventhub-git-fix-links-acme.vercel.app";
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "email", value: "p1@example.com" }, role: "planner", locale: "en", appUrl: resolveAppUrl() });
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "email", value: "p2@example.com" }, role: "host", locale: "hi", appUrl: "" });
    const rows = (await outbox()).slice(checked);
    expect(rows).toHaveLength(2);
    for (const m of rows) {
      expect(m.body).not.toMatch(/localhost/);
      expect(m.body.match(URL_RE)).toEqual([`${branch}/login`]);
    }
  });
});

// ---------------------------------------------------------------------------
// Guest messages from the outbox: RSVP reminders, broadcasts, thank-yous, gallery
// ---------------------------------------------------------------------------

describe("guest messages", () => {
  it("RSVP reminders (en email, hi SMS) link to the family's /g/<token>", async () => {
    const w = await world();
    const en = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, [w.mehendi.id]);
    const hi = await w.family("Sharma", "hi", { phone: "+919876500050" }, [w.mehendi.id]);
    const enPhone = await w.family("Mehta", "en", { phone: "+919876500051" }, [w.mehendi.id]);
    await db().update(events).set({ rsvpDeadline: "2026-11-20" }).where(eq(events.id, w.event.id));
    expect(await sendRsvpReminders(db(), resolveAppUrl(), new Date("2026-11-10T04:00:00Z"))).toBe(3);
    const msgs = await fresh();
    const mail = msgs.find((m) => m.to === "kapoor@example.com")!;
    const text = msgs.find((m) => m.to === "+919876500050")!;
    await expectOwnGuestLink(expectLink(mail, GUEST_LINK), en.household.id);
    await expectOwnGuestLink(expectLink(text, GUEST_LINK), hi.household.id);
    expect(mail.body).toContain("20 November 2026");
    expect(text.body).toContain("नवंबर");
    expect(isDevanagari(text.body)).toBe(true);
    recordSms("rsvp.reminderMessage", "hi", text);
    const enText = msgs.find((m) => m.to === "+919876500051")!;
    await expectOwnGuestLink(expectLink(enText, GUEST_LINK), enPhone.household.id);
    recordSms("rsvp.reminderMessage", "en", enText);
  });

  it("broadcasts: personal link on every channel, unsubscribe on email; Hindi body for Hindi families", async () => {
    const w = await world();
    const en = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, [w.mehendi.id]);
    const hi = await w.family("Sharma", "hi", { phone: "+919876500060" }, [w.mehendi.id]);
    const b = await createDraft(db(), w.event.id, w.actor, {
      title: "Baraat at 7",
      bodyEn: "The baraat leaves the hotel at 7 pm sharp.",
      bodyHi: "बारात शाम 7 बजे होटल से निकलेगी।",
      channels: ["whatsapp", "email", "sms"],
      segment: {},
    });
    await sendBroadcast(db(), w.event.id, b.id, w.actor, resolveAppUrl());
    const msgs = await fresh();
    const mail = msgs.find((m) => m.to === "kapoor@example.com")!;
    const wa = msgs.find((m) => m.to === "+919876500060")!;
    expect(wa.channel).toBe("whatsapp");
    await expectOwnGuestLink(expectLink(mail, GUEST_LINK), en.household.id);
    const unsub = expectLink(mail, /^\/u\/[A-Za-z0-9_.-]+$/);
    expect(readUnsubscribeToken(unsub.slice(3))).toMatchObject({ eventId: w.event.id, channel: "email", address: "kapoor@example.com" });
    expect(mail.subject).toContain(COUPLE);
    await expectOwnGuestLink(expectLink(wa, GUEST_LINK), hi.household.id);
    expect(wa.body).toContain("बारात");
    expect(wa.body).not.toMatch(/\/u\//);
  });

  it("thank-you notes: merge fields filled, no links, no amounts", async () => {
    const w = await world();
    const fam = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, [w.mehendi.id]);
    const G: GiftCtx = { eventId: w.event.id, actor: w.actor, subject: hostS };
    const tpl = await saveTemplate(db(), G, null, { locale: "en", name: "Warm", body: "Dear {guestName}, thank you for coming. {personalLine} {coupleNames}" });
    const ty = await saveDraft(db(), G, fam.household.id, { templateId: tpl.id, personalLine: "Loved dancing with you." });
    await sendThankYous(db(), G, [ty.id], { bulk: false });
    const [m] = await fresh();
    expect(m.subject).toBe(COUPLE);
    expect(m.body).toContain("Dear Kapoor");
    expect(m.body).toContain("Loved dancing with you.");
    expect(m.body.match(URL_RE)).toBeNull();
  });

  it("gallery ready (en email with unsubscribe, hi WhatsApp) links to /g/<token>?to=gallery; photo notifications", async () => {
    const w = await world();
    const en = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, [w.sangeet.id]);
    const hi = await w.family("Sharma", "hi", { phone: "+919876500070" }, [w.sangeet.id]);
    const member: Uploader = { kind: "member", userId: w.host.id };
    const album = await createAlbum(db(), { eventId: w.event.id, actor: w.actor, functionId: w.sangeet.id, title: "Dance" });
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 60, b: 40 } } }).jpeg().toBuffer();
    const begun = await beginUpload(db(), store, w.event.id, member, { functionId: w.sangeet.id, albumId: album.id, clientKey: randomUUID(), filename: "a.jpg", mime: "image/jpeg", size: bytes.length });
    if (!("grant" in begun)) throw new Error("expected a grant");
    await store.put(begun.grant.key, bytes, "image/jpeg");
    const item = await completeUpload(db(), store, w.event.id, member, begun.mediaId);
    await processRenditions(db(), store);
    await releaseAlbum(db(), { eventId: w.event.id, actor: w.actor, albumId: album.id, release: true, appUrl: resolveAppUrl() });
    const msgs = await fresh();
    const mail = msgs.find((m) => m.to === "kapoor@example.com")!;
    const wa = msgs.find((m) => m.to === "+919876500070")!;
    const link = expectLink(mail, /^\/g\/[A-Za-z0-9_-]{44}\?to=gallery$/);
    await expectOwnGuestLink(link, en.household.id);
    expectLink(mail, /^\/u\//);
    expect(mail.subject).toContain("Sangeet");
    expect(mail.subject).toContain(COUPLE);
    await expectOwnGuestLink(expectLink(wa, /^\/g\/[A-Za-z0-9_-]{44}\?to=gallery$/), hi.household.id);
    expect(isDevanagari(wa.body)).toBe(true);

    // A family asks for a photo to be removed; a photographer gets an album selection.
    await requestRemoval(db(), w.event.id, { kind: "guest", householdId: en.household.id, functionIds: [w.sangeet.id] }, item.id, "I'm in this one");
    const photo = await w.book("Lens", "lens@example.com", "photography", w.sangeet.id);
    await toggleFavourite(db(), { eventId: w.event.id, userId: w.host.id, mediaId: item.id });
    const sel = await createSelection(db(), w.event.id, w.actor, { bookingId: (await photoBookings(db(), w.event.id))[0].bookingId, title: "Album 1", deadline: "2027-01-15", note: null });
    await addToSelection(db(), { eventId: w.event.id, selectionId: sel.id, favourites: true });
    await shareSelection(db(), { eventId: w.event.id, actor: w.actor, selectionId: sel.id });
    void photo;
    await fresh();
    const rows = await checkNotifications();
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["gallery.removal_requested", "vendor.gallery_selection"]));
  });
});

// ---------------------------------------------------------------------------
// Team reminders and notifications
// ---------------------------------------------------------------------------

describe("team reminders", () => {
  it("task reminders link to /events (default base, no appUrl passed)", async () => {
    const w = await world();
    await createTask(db(), w.event.id, w.actor, taskSchema.parse({ title: "Book the pandit", assigneeId: w.host.id, dueDate: "2026-10-30" }));
    expect(await sendTaskReminders(db(), new Date("2026-11-01T04:00:00Z"))).toBe(1);
    const [m] = await fresh();
    expectLink(m, /^\/events$/);
    expect(m.body).toContain(EVENT_NAME);
  });

  it("payment reminders link to the event's payables; approval reminders to its approvals", async () => {
    const w = await world();
    const planner = await makeUser("planner@example.com", "Ravi");
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "email", value: "planner@example.com" }, role: "planner", locale: "en", appUrl: resolveAppUrl() });
    const c = await w.book("Spice", "chef@spice.in", "catering", w.mehendi.id);
    await db().update(paymentMilestones).set({ dueDate: TODAY }).where(and(eq(paymentMilestones.bookingId, c.booking.id), eq(paymentMilestones.kind, "advance")));
    await fresh();
    expect(await sendPaymentReminders(db(), new Date("2026-11-01T03:00:00Z"))).toBe(2);
    const pay = await fresh();
    expect(pay).toHaveLength(2);
    for (const m of pay) {
      expectLink(m, new RegExp(`^/events/${w.event.id}/budget/payables$`));
      expect(m.subject).toContain(EVENT_NAME);
      expect(m.body).toContain("Spice");
    }

    const P = { eventId: w.event.id, actor: actorOf(planner), subject: plannerS };
    await addService(db(), P, { functionId: w.sangeet.id, serviceTypeId: w.types.find((t) => t.systemKey === "decor")!.id });
    expect(await sendApprovalReminders(db(), new Date(Date.now() + 25 * 3600_000))).toBe(1);
    const [appr] = await fresh();
    expectLink(appr, new RegExp(`^/events/${w.event.id}/approvals$`));
    expect(appr.subject).toContain(EVENT_NAME);

    // The Host's decision reaches the Planner in-app and by email (approval.*).
    const [req] = await db().select().from(approvalRequests).where(eq(approvalRequests.eventId, w.event.id));
    await decideRequest(db(), { eventId: w.event.id, requestId: req.id, actor: w.actor, subject: hostS, decision: "request_changes", comment: "Fewer flowers" });
    await addService(db(), P, { functionId: w.sangeet.id, serviceTypeId: w.types.find((t) => t.systemKey === "decor")!.id });
    await addService(db(), P, { functionId: w.mehendi.id, serviceTypeId: w.types.find((t) => t.systemKey === "decor")!.id });
    const pending = await db().select().from(approvalRequests).where(and(eq(approvalRequests.eventId, w.event.id), eq(approvalRequests.status, "pending")));
    await decideRequest(db(), { eventId: w.event.id, requestId: pending[0].id, actor: w.actor, subject: hostS, decision: "approve" });
    await decideRequest(db(), { eventId: w.event.id, requestId: pending[1].id, actor: w.actor, subject: hostS, decision: "reject", comment: "Not needed" });
    const mails = await fresh();
    const toPlanner = mails.filter((m) => m.to === "planner@example.com");
    expect(toPlanner).toHaveLength(3);
    for (const m of toPlanner) {
      expectLink(m, new RegExp(`^/events/${w.event.id}/approvals$`));
      expect(m.subject).toContain(EVENT_NAME);
    }
    const kinds = (await checkNotifications()).map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["approval.requested", "approval.approved", "approval.rejected", "approval.changes_requested", "vendor.booking_changed"]));
  });

  it("vendor portal, chat and caterer headcount notifications (in-app + email)", async () => {
    const w = await world();
    const c = await w.book("Spice", "chef@spice.in", "catering", w.mehendi.id);
    // Vendor quote and invoice from the portal.
    const [requestId] = await createQuoteRequests(db(), w.event.id, w.actor, { vendorIds: [c.vendor.id], serviceIds: [c.svc.id], dueDate: null, message: null });
    await submitPortalQuote(db(), { eventId: w.event.id, vendorId: c.vendor.id, actor: actorOf(c.user), requestId, reviseQuoteId: null, quote: quoteFor(c.req, 90_000_00) });
    await uploadPortalInvoice(db(), {
      eventId: w.event.id,
      vendorId: c.vendor.id,
      actor: actorOf(c.user),
      invoice: { bookingId: c.booking.id, number: "INV-7", invoiceDate: TODAY, dueDate: null, supplierGstin: null, taxType: "none", notes: null, lines: [{ serviceId: null, description: "Food", hsnSac: null, amountPaise: 100_00, gstRateBps: 0 }] },
    });
    // Chat: a mention, a team message, a message to the vendor.
    const planner = await makeUser("planner@example.com", "Ravi");
    await inviteMember(db(), { event: w.event, actor: w.actor, inviterName: "Asha", identifier: { type: "email", value: "planner@example.com" }, role: "planner", locale: "hi", appUrl: resolveAppUrl() });
    await db().update(users).set({ locale: "hi" }).where(eq(users.id, planner.id));
    const hostV: ChatViewer = { kind: "member", userId: w.host.id };
    await postMessage(db(), w.event.id, { kind: "team" }, hostV, { body: "@Ravi please check the menu", mentions: [planner.id] });
    await postMessage(db(), w.event.id, { kind: "function", id: w.mehendi.id }, hostV, { body: "Mehendi plan" });
    await postMessage(db(), w.event.id, { kind: "vendor", id: c.vendor.id }, hostV, { body: "Menu?" });
    await postMessage(db(), w.event.id, { kind: "vendor", id: c.vendor.id }, { kind: "vendor", userId: c.user.id, vendorId: c.vendor.id }, { body: "Sending today" });
    // Headcount: baseline, a big move, then a final-count lock.
    const fam = await w.family("Base", "en", { phone: "+919876500080" }, [w.mehendi.id]);
    const extra = await db()
      .insert(guests)
      .values(Array.from({ length: 9 }, (_, i) => ({ eventId: w.event.id, householdId: fam.household.id, name: `Base ${i}` })))
      .returning();
    await db().insert(functionInvites).values(extra.map((g) => ({ functionId: w.mehendi.id, guestId: g.id })));
    const all = [fam.guest, ...extra.slice(0, 4)];
    await saveRsvps(db(), { household: fam.household, event: w.event, answers: all.map((g) => ({ guestId: g.id, functionId: w.mehendi.id, status: "attending" as const })), recordedBy: w.actor });
    await getCatererView(db(), w.event.id, c.vendor.id, w.mehendi.id);
    await saveRsvps(db(), { household: fam.household, event: w.event, answers: extra.slice(4).map((g) => ({ guestId: g.id, functionId: w.mehendi.id, status: "attending" as const })), recordedBy: w.actor });
    expect(await checkHeadcountAlerts(db())).toBe(1);
    await setHeadcountLock(db(), { eventId: w.event.id, actor: w.actor, bookingId: c.booking.id, functionId: w.mehendi.id, lockAt: new Date("2026-01-01T00:00:00Z") });

    const mails = await fresh();
    const rows = await checkNotifications();
    const kinds = rows.map((n) => n.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["vendor.quote_submitted", "vendor.invoice_uploaded", "mention", "chat.message", "vendor.message", "headcount.changed", "headcount.locked"]),
    );
    // Vendor-side emails link into the vendor portal; team-side ones into the event.
    const toChef = mails.filter((m) => m.to === "chef@spice.in");
    expect(toChef.some((m) => (m.body.match(URL_RE) ?? []).some((u) => u.startsWith(`${BASE}/vendor/${c.vendor.id}/headcount/${w.mehendi.id}`)))).toBe(true);
    const toPlanner = mails.filter((m) => m.to === "planner@example.com");
    const mention = toPlanner.find((m) => m.body.includes("please check the menu"))!;
    expect(isDevanagari(mention.body)).toBe(true);
    expectLink(mention, new RegExp(`^/events/${w.event.id}/messages/team$`));
  });
});

describe("limits, retention and gifts", () => {
  it("message and storage usage warnings link to /usage; channel shown by name", async () => {
    const w = await world();
    await db().insert(eventLimitOverrides).values({ eventId: w.event.id, channel: "email", limit: 1 });
    const fam = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, []);
    await sendGuestLink(db(), { household: fam.household, event: w.event, channel: "email", to: "kapoor@example.com", appUrl: resolveAppUrl() });
    // Through the outbox so it counts: a broadcast to the one family.
    const b = await createDraft(db(), w.event.id, w.actor, { title: "Hello", bodyEn: "Hello", channels: ["email"], segment: {} });
    await sendBroadcast(db(), w.event.id, b.id, w.actor, resolveAppUrl());
    await db().insert(eventStorageOverrides).values({ eventId: w.event.id, storageBytes: 1000 });
    await db().transaction(async (tx) => {
      await reserve(tx, w.event.id, 900, "member");
      await commit(tx, w.event.id, 900);
    });
    await fresh();
    const rows = await checkNotifications();
    const usage = rows.find((n) => n.kind === "usage.warning")!;
    expect(usage).toBeDefined();
    expect(renderNotification("en", usage)).toMatch(/^Email messages/);
    expect(rows.some((n) => n.kind === "usage.storageWarning")).toBe(true);
    const mails = await fresh();
    void mails;
    const all = await outbox();
    const warn = all.find((m) => m.to === "host@example.com" && /% of this event's limit/.test(m.body));
    expectLink(warn, new RegExp(`^/events/${w.event.id}/usage$`));
  });

  it("retention reminders: Host email → settings#data (archive), vendor email → their portal (en + hi)", async () => {
    const w = await world();
    await db().update(users).set({ locale: "hi" }).where(eq(users.id, w.host.id));
    const vendor = await createVendor(db(), w.event.id, w.actor, { name: "Spice", contactName: null, phone: null, email: null, gstin: null, notes: null, serviceTypeIds: [] });
    const chef = await makeUser("chef@example.com", "Chef");
    await db().insert(vendorContacts).values({ eventId: w.event.id, vendorId: vendor.id, identifierType: "email", identifierValue: "chef@example.com", userId: chef.id, acceptedAt: new Date() });
    await fresh();
    // Deletion 1 year after the last function (2026-12-10) → 2027-12-10; 60 days before.
    expect(await sendRetentionReminders(db(), new Date("2027-10-11T00:30:00Z"))).toBe(1);
    const msgs = await fresh();
    const toHost = msgs.find((m) => m.to === "host@example.com");
    const toChef = msgs.find((m) => m.to === "chef@example.com");
    expectLink(toHost, new RegExp(`^/events/${w.event.id}/settings#data$`));
    expect(isDevanagari(toHost!.body)).toBe(true);
    expect(toHost!.subject).toContain(EVENT_NAME);
    expectLink(toChef, new RegExp(`^/vendor/${vendor.id}$`));
    expect(toChef!.subject).toContain(EVENT_NAME);
    const kinds = (await checkNotifications()).map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["retention.reminder", "vendor.retention"]));
  });

  it("gift notifications (gift due soon, thank-you reminder) link to gifts and carry no costs", async () => {
    const w = await world();
    const G: GiftCtx = { eventId: w.event.id, actor: w.actor, subject: hostS };
    await createGiftItem(db(), G, { name: "Silver coin", category: "return_gift", functionId: w.sangeet.id, quantityMode: "fixed", quantityFixed: 10, unitCostPaise: 2345_00 });
    // Sangeet is on 2026-12-10: within 7 days on 12-05 (IST).
    expect(await sendGiftReminders(db(), new Date("2026-12-05T06:00:00Z"))).toBe(1);
    const fam = await w.family("Kapoor", "en", { email: "kapoor@example.com" }, [w.sangeet.id]);
    const { checkIns } = await import("@/db/schema");
    await db().insert(checkIns).values({ eventId: w.event.id, functionId: w.sangeet.id, guestId: fam.guest.id, checkedInAt: new Date(), checkedInBy: w.host.id, source: "manual" });
    // 4 weeks after the last function (2026-12-10).
    expect(await sendThankYouReminders(db(), new Date("2027-01-07T06:00:00Z"))).toBe(1);
    await fresh();
    const rows = await checkNotifications();
    expect(rows.map((n) => n.kind)).toEqual(expect.arrayContaining(["gift.due", "thank_you.reminder"]));
    // Gift costs never go out by email.
    expect((await outbox()).filter((m) => /2,?345/.test(m.body))).toHaveLength(0);
  });
});

describe("coverage", () => {
  it("every notification kind in the catalogue was triggered and checked (except unused ones)", async () => {
    const en = (await import("@/i18n/messages/en")).default;
    // approval.cancelled has text but nothing sends it (withdrawing notifies no one).
    const unused = new Set(["approval.cancelled"]);
    const all = Object.keys(en.notifications.kinds).filter((k) => !unused.has(k));
    expect(all.filter((k) => !kindsSeen.has(k))).toEqual([]);
  });

  it("SMS lengths are reported", () => {
    expect(sms.length).toBeGreaterThan(0);
  });
});
