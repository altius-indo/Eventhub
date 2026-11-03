"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { acknowledgeHeadcount, HeadcountError } from "@/lib/caterer-headcount";
import { isUuid } from "@/lib/ids";
import { QuoteError, quoteInput, type LineInput } from "@/lib/quotes";
import { bpsField, dateField, intField, optStr, paiseField, signedPaiseField } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { getPortalRequest, PortalError, submitPortalQuote } from "@/lib/vendor-portal";
import { todayIn } from "@/lib/tasks";

type State = { error?: string; info?: string };

/**
 * The vendor's quote form (VND-03/10): one row per requirement, an extra per service and up to
 * three package lines. Ids come from the request the vendor may see, never from the form.
 */
export async function submitQuoteAction(vendorId: string, requestId: string, reviseQuoteId: string | null, _p: State, fd: FormData): Promise<State> {
  const ctx = await getVendorContext(vendorId);
  const { t } = await getTranslator();
  if (!ctx.can("portal.quote") || !isUuid(requestId) || (reviseQuoteId && !isUuid(reviseQuoteId))) return { error: t("common.notAllowed") };
  const db = getDb();
  const eventId = ctx.event.id;
  let request;
  try {
    request = await getPortalRequest(db, eventId, vendorId, requestId);
  } catch (e) {
    if (e instanceof PortalError) return { error: t(`vendorPortal.errors.${e.code}`) };
    throw e;
  }
  const bad = () => ({ error: t("quotes.errors.invalid") });
  const gst = bpsField(fd, "gstRate", 0);
  if (gst === undefined) return bad();
  const lines: LineInput[] = [];
  for (const s of request.services) {
    if (s.cancelled) continue;
    for (const r of s.requirements) {
      const amount = paiseField(fd, `amt_${r.id}`);
      const qty = intField(fd, `qty_${r.id}`);
      if (amount === undefined || qty === undefined) return bad();
      if (amount == null) continue;
      lines.push({ scope: "requirement", serviceId: s.id, requirementId: r.id, description: null, quantity: qty, amountPaise: amount, gstRateBps: gst, conditional: false, allocation: null });
    }
    const extra = paiseField(fd, `xamt_${s.id}`);
    if (extra === undefined) return bad();
    if (extra != null) lines.push({ scope: "service", serviceId: s.id, requirementId: null, description: optStr(fd, `xdesc_${s.id}`), quantity: null, amountPaise: extra, gstRateBps: gst, conditional: false, allocation: null });
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
    receivedOn: todayIn(ctx.event.timezone),
    validUntil: dateField(fd, "validUntil"),
    terms: optStr(fd, "terms"),
    taxType: ["cgst_sgst", "igst"].includes(String(fd.get("taxType"))) ? String(fd.get("taxType")) : "none",
    allOrNothing: fd.get("allOrNothing") === "on",
    minFunctions: minFunctions && minFunctions >= 2 ? minFunctions : null,
    lines,
  });
  if (!parsed.success) return bad();
  try {
    await submitPortalQuote(db, { eventId, vendorId, actor: ctx.actor, requestId, reviseQuoteId, quote: parsed.data });
  } catch (e) {
    if (e instanceof PortalError) return { error: t(`vendorPortal.errors.${e.code}`) };
    if (e instanceof QuoteError) return { error: t(`quotes.errors.${e.code}`) };
    throw e;
  }
  revalidatePath(`/vendor/${vendorId}`, "layout");
  redirect(`/vendor/${vendorId}/requests/${requestId}?sent=1`);
}

export async function acknowledgeAction(vendorId: string, functionId: string, _p: State): Promise<State> {
  const ctx = await getVendorContext(vendorId);
  const { t } = await getTranslator();
  if (!ctx.can("portal.headcount") || ctx.viaAdmin || !isUuid(functionId)) return { error: t("common.notAllowed") };
  try {
    await acknowledgeHeadcount(getDb(), { eventId: ctx.event.id, vendorId, functionId, actor: ctx.actor });
  } catch (e) {
    if (e instanceof HeadcountError) return { error: t(`headcount.staff.errors.${e.code}`) };
    throw e;
  }
  revalidatePath(`/vendor/${vendorId}/headcount/${functionId}`);
  return { info: t("headcount.acknowledged") };
}
