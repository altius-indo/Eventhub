"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  addKeyDate,
  BookingError,
  cancelBooking,
  milestoneSchema,
  proposeBooking,
  removeKeyDate,
  reviseBooking,
  updateContract,
  updateSchedule,
  type MilestoneInput,
} from "@/lib/bookings";
import { hasRecentStepUp } from "@/lib/auth-core";
import { isUuid, uuids } from "@/lib/ids";
import { ForbiddenError } from "@/lib/policy";
import { closeQuoteRequest, createQuoteRequests, declineQuote, getQuoteRequest, QuoteError, quoteInput, saveQuote, type LineInput } from "@/lib/quotes";
import {
  archiveVendor,
  bankSchema,
  createVendor,
  deleteVendor,
  setRating,
  setVendorSecrets,
  updateVendor,
  VendorError,
  vendorSchema,
} from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { bpsField, dateField, dctx, eventToday, intField, optStr, paiseField, payerField, resultInfo, signedPaiseField } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };
type T = Awaited<ReturnType<typeof getTranslator>>["t"];
const refresh = (eventId: string) => revalidatePath(`/events/${eventId}`, "layout");

function fail(t: T, e: unknown): State {
  if (e instanceof VendorError) return { error: t(`vendors.errors.${e.code}`) };
  if (e instanceof QuoteError) return { error: t(`quotes.errors.${e.code}`) };
  if (e instanceof BookingError) return { error: t(`bookings.errors.${e.code}`) };
  if (e instanceof ForbiddenError) return { error: t("common.notAllowed") };
  throw e;
}

async function editor(eventId: string, ...ids: string[]) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, ok: ctx.can("vendors.edit") && ids.every(isUuid) };
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

const vendorFrom = (fd: FormData) =>
  vendorSchema.safeParse({
    name: String(fd.get("name") ?? ""),
    contactName: String(fd.get("contactName") ?? ""),
    phone: String(fd.get("phone") ?? ""),
    email: String(fd.get("email") ?? ""),
    gstin: String(fd.get("gstin") ?? ""),
    notes: String(fd.get("notes") ?? ""),
    serviceTypeIds: uuids(fd.getAll("serviceTypeIds").map(String)),
  });

export async function createVendorAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId);
  if (!ok) return { error: t("common.notAllowed") };
  const parsed = vendorFrom(fd);
  if (!parsed.success) return { error: t("vendors.errors.invalid") };
  let id: string;
  try {
    id = (await createVendor(getDb(), eventId, ctx.actor, parsed.data)).id;
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/vendors/${id}`);
}

export async function updateVendorAction(eventId: string, vendorId: string, _p: State, fd: FormData): Promise<State> {
  const { t, ok } = await editor(eventId, vendorId);
  if (!ok) return { error: t("common.notAllowed") };
  const parsed = vendorFrom(fd);
  if (!parsed.success) return { error: t("vendors.errors.invalid") };
  try {
    await updateVendor(getDb(), eventId, vendorId, parsed.data);
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function setSecretsAction(eventId: string, vendorId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, vendorId);
  if (!ok || !ctx.can("vendors.bank_view")) return { error: t("common.notAllowed") };
  // Changing where money goes needs a fresh one-time code (EVT-01d).
  if (!hasRecentStepUp(ctx.session)) redirect(`/step-up?next=${encodeURIComponent(`/events/${eventId}/vendors/${vendorId}`)}`);
  const pan = String(fd.get("pan") ?? "").trim();
  const acct = String(fd.get("accountNumber") ?? "").replace(/\s/g, "");
  let bank: ReturnType<typeof bankSchema.parse> | undefined;
  if (acct) {
    const parsed = bankSchema.safeParse({
      accountName: String(fd.get("accountName") ?? ""),
      accountNumber: acct,
      ifsc: String(fd.get("ifsc") ?? ""),
      upi: String(fd.get("upi") ?? ""),
    });
    if (!parsed.success) return { error: t("vendors.errors.bank") };
    bank = parsed.data;
  }
  if (!pan && !bank) return { error: t("vendors.errors.invalid") };
  try {
    await setVendorSecrets(getDb(), eventId, vendorId, ctx.actor, { ...(pan ? { pan } : {}), ...(bank ? { bank } : {}) });
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("vendors.secretsSaved") };
}

export async function rateVendorAction(eventId: string, vendorId: string, _p: State, fd: FormData): Promise<State> {
  const { t, ok } = await editor(eventId, vendorId);
  if (!ok) return { error: t("common.notAllowed") };
  const r = intField(fd, "rating");
  if (r === undefined) return { error: t("vendors.errors.invalid") };
  try {
    await setRating(getDb(), eventId, vendorId, r, optStr(fd, "ratingNote"));
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function archiveVendorAction(eventId: string, vendorId: string, archived: boolean) {
  const { ok } = await editor(eventId, vendorId);
  if (!ok) return;
  await archiveVendor(getDb(), eventId, vendorId, archived).catch((e) => {
    if (!(e instanceof VendorError)) throw e;
  });
  refresh(eventId);
}

export async function deleteVendorAction(eventId: string, vendorId: string, _p: State): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, vendorId);
  if (!ok) return { error: t("common.notAllowed") };
  try {
    await deleteVendor(getDb(), eventId, vendorId, ctx.actor);
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/vendors`);
}

// ---------------------------------------------------------------------------
// Quote requests and quotes
// ---------------------------------------------------------------------------

export async function createRequestsAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId);
  if (!ok) return { error: t("common.notAllowed") };
  const serviceIds = uuids(fd.getAll("serviceIds").map(String));
  const vendorIds = uuids(fd.getAll("vendorIds").map(String));
  if (!serviceIds.length || !vendorIds.length) return { error: t("quotes.errors.pick") };
  let ids: string[];
  try {
    ids = await createQuoteRequests(getDb(), eventId, ctx.actor, { serviceIds, vendorIds, dueDate: dateField(fd, "dueDate"), message: optStr(fd, "message") });
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(ids.length === 1 ? `/events/${eventId}/vendors/requests/${ids[0]}?created=1` : `/events/${eventId}/vendors/requests?created=1`);
}

export async function closeRequestAction(eventId: string, requestId: string, closed: boolean) {
  const { ok } = await editor(eventId, requestId);
  if (!ok) return;
  await closeQuoteRequest(getDb(), eventId, requestId, closed).catch((e) => {
    if (!(e instanceof QuoteError)) throw e;
  });
  refresh(eventId);
}


/** Reads the quote entry form: one row per requirement, an extra per service, up to 3 package lines. */
export async function saveQuoteAction(eventId: string, requestId: string, reviseQuoteId: string | null, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, requestId, ...(reviseQuoteId ? [reviseQuoteId] : []));
  if (!ok) return { error: t("common.notAllowed") };
  const db = getDb();
  let request;
  try {
    request = await getQuoteRequest(db, eventId, requestId);
  } catch (e) {
    return fail(t, e);
  }
  const gst = bpsField(fd, "gstRate", 0);
  if (gst === undefined) return { error: t("quotes.errors.invalid") };
  const lines: LineInput[] = [];
  const bad = () => ({ error: t("quotes.errors.invalid") });
  for (const s of request.services) {
    for (const r of s.requirements) {
      const amount = paiseField(fd, `amt_${r.id}`);
      const qty = intField(fd, `qty_${r.id}`);
      if (amount === undefined || qty === undefined) return bad();
      if (amount == null) continue;
      lines.push({ scope: "requirement", serviceId: s.service.id, requirementId: r.id, description: null, quantity: qty, amountPaise: amount, gstRateBps: gst, conditional: false, allocation: null });
    }
    const extra = paiseField(fd, `xamt_${s.service.id}`);
    if (extra === undefined) return bad();
    if (extra != null) lines.push({ scope: "service", serviceId: s.service.id, requirementId: null, description: optStr(fd, `xdesc_${s.service.id}`), quantity: null, amountPaise: extra, gstRateBps: gst, conditional: false, allocation: null });
  }
  for (let i = 0; i < 3; i++) {
    const amount = signedPaiseField(fd, `pamt_${i}`);
    if (amount === undefined) return bad();
    if (amount == null) continue;
    lines.push({ scope: "package", serviceId: null, requirementId: null, description: optStr(fd, `pdesc_${i}`), quantity: null, amountPaise: amount, gstRateBps: gst, conditional: fd.get(`pcond_${i}`) === "on", allocation: null });
  }
  const minFunctions = intField(fd, "minFunctions");
  if (minFunctions === undefined) return bad();
  const parsed = quoteInput.safeParse({
    vendorRef: optStr(fd, "vendorRef"),
    receivedOn: dateField(fd, "receivedOn"),
    validUntil: dateField(fd, "validUntil"),
    terms: optStr(fd, "terms"),
    taxType: ["cgst_sgst", "igst"].includes(String(fd.get("taxType"))) ? String(fd.get("taxType")) : "none",
    allOrNothing: fd.get("allOrNothing") === "on",
    minFunctions: minFunctions && minFunctions >= 2 ? minFunctions : null,
    lines,
  });
  if (!parsed.success) return bad();
  let id: string;
  try {
    id = (await saveQuote(db, eventId, ctx.actor, { requestId, reviseQuoteId }, parsed.data)).id;
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/vendors/quotes/${id}?saved=1`);
}

export async function declineQuoteAction(eventId: string, quoteId: string, declined: boolean) {
  const { ok } = await editor(eventId, quoteId);
  if (!ok) return;
  await declineQuote(getDb(), eventId, quoteId, declined).catch((e) => {
    if (!(e instanceof QuoteError)) throw e;
  });
  refresh(eventId);
}

// ---------------------------------------------------------------------------
// Bookings (VND-06/07/09, PAY-02)
// ---------------------------------------------------------------------------

export async function bookAction(eventId: string, quoteId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("bookings.create") || !isUuid(quoteId)) return { error: t("common.notAllowed") };
  const lineIds = uuids(fd.getAll("line").map(String));
  let res;
  try {
    res = await proposeBooking(getDb(), dctx(ctx), { quoteId, lineIds, notes: optStr(fd, "notes"), today: eventToday(ctx.event.timezone) });
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  // Only warning codes travel in the URL; text is never taken from it.
  const w = res.warnings.length ? `&w=${[...new Set(res.warnings.map((x) => x.code))].join(",")}` : "";
  redirect(`/events/${eventId}/vendors/bookings/${res.booking.id}?r=${res.result.status === "pending" ? "pending" : res.result.auto ? "auto" : "ok"}${w}`);
}

export async function reviseBookingAction(eventId: string, bookingId: string, quoteId: string, lineIds: string[], _p: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("bookings.create") || ![bookingId, quoteId, ...lineIds].every(isUuid)) return { error: t("common.notAllowed") };
  try {
    const r = await reviseBooking(getDb(), dctx(ctx), bookingId, { quoteId, lineIds, today: eventToday(ctx.event.timezone) });
    refresh(eventId);
    return { info: resultInfo(t, r.result) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function cancelBookingAction(eventId: string, bookingId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("bookings.create") || !isUuid(bookingId)) return { error: t("common.notAllowed") };
  try {
    const r = await cancelBooking(getDb(), dctx(ctx), bookingId, String(fd.get("reason") ?? ""));
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

/** Schedule rows: kind_i, label_i, amount_i, due_i (+ payer per row is the booking default). */
export async function scheduleAction(eventId: string, bookingId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("bookings.create") || !isUuid(bookingId)) return { error: t("common.notAllowed") };
  const rows: MilestoneInput[] = [];
  for (let i = 0; i < 12; i++) {
    const amount = paiseField(fd, `amount_${i}`);
    if (amount === undefined) return { error: t("bookings.errors.invalid") };
    if (amount == null) continue;
    if (payerField(fd, `payer_${i}`) === undefined) return { error: t("payer.invalid") };
    const parsed = milestoneSchema.safeParse({
      kind: ["advance", "milestone", "final"].includes(String(fd.get(`kind_${i}`))) ? String(fd.get(`kind_${i}`)) : "milestone",
      label: optStr(fd, `label_${i}`),
      amountPaise: amount,
      dueDate: dateField(fd, `due_${i}`),
      payer: payerField(fd, `payer_${i}`),
    });
    if (!parsed.success) return { error: t("bookings.errors.invalid") };
    rows.push(parsed.data);
  }
  try {
    const r = await updateSchedule(getDb(), dctx(ctx), bookingId, rows);
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function contractAction(eventId: string, bookingId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("contracts.edit") || !isUuid(bookingId)) return { error: t("common.notAllowed") };
  try {
    await updateContract(getDb(), eventId, ctx.actor, bookingId, { cancellationPolicy: optStr(fd, "cancellationPolicy"), deliverables: optStr(fd, "deliverables"), notes: optStr(fd, "notes") });
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function addKeyDateAction(eventId: string, bookingId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const assignee = String(fd.get("assigneeId") ?? "");
  if (!ctx.can("contracts.edit") || !isUuid(bookingId) || (assignee && !isUuid(assignee))) return { error: t("common.notAllowed") };
  const label = String(fd.get("label") ?? "").trim();
  const date = dateField(fd, "date");
  if (!label || label.length > 120 || !date) return { error: t("bookings.errors.invalid") };
  try {
    await addKeyDate(getDb(), eventId, ctx.actor, bookingId, { label, date, assigneeId: assignee || null });
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function removeKeyDateAction(eventId: string, keyDateId: string) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("contracts.edit") || !isUuid(keyDateId)) return;
  await removeKeyDate(getDb(), eventId, keyDateId).catch((e) => {
    if (!(e instanceof BookingError)) throw e;
  });
  refresh(eventId);
}
