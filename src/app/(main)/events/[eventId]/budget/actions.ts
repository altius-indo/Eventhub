"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { events } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hasRecentStepUp } from "@/lib/auth-core";
import { addBudgetLine, budgetLineSchema, BudgetError, deleteBudgetLine, updateBudgetLine } from "@/lib/budget";
import { CatalogueError, setThreshold } from "@/lib/catalogue";
import { isUuid } from "@/lib/ids";
import { GST_STATES } from "@/lib/money";
import { createInvoice, deleteInvoice, deletePayment, invoiceInput, PaymentError, paymentInput, recordPayment } from "@/lib/payments";
import { ForbiddenError } from "@/lib/policy";
import { getEventContext } from "@/lib/server/event-context";
import { bpsField, dateField, dctx, optStr, paiseField, payerField, resultInfo, signedPaiseField } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };
type T = Awaited<ReturnType<typeof getTranslator>>["t"];
const refresh = (eventId: string) => revalidatePath(`/events/${eventId}`, "layout");

function fail(t: T, e: unknown): State {
  if (e instanceof BudgetError) return { error: t(`budget.errors.${e.code}`) };
  if (e instanceof PaymentError) return { error: t(`payments.errors.${e.code}`) };
  if (e instanceof ForbiddenError) return { error: t("common.notAllowed") };
  if (e instanceof CatalogueError) return { error: t("budget.errors.invalid") };
  throw e;
}

function lineFrom(fd: FormData) {
  const estimate = paiseField(fd, "estimate");
  if (estimate === undefined) return null;
  const fn = String(fd.get("functionId") ?? "");
  const parsed = budgetLineSchema.safeParse({
    categoryId: String(fd.get("categoryId") ?? ""),
    functionId: fn && isUuid(fn) ? fn : null,
    title: String(fd.get("title") ?? ""),
    estimatePaise: estimate ?? 0,
    payer: payerField(fd),
    notes: optStr(fd, "notes"),
  });
  return parsed.success ? parsed.data : null;
}

export async function addLineAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("budget.edit")) return { error: t("common.notAllowed") };
  if (payerField(fd) === undefined) return { error: t("payer.invalid") };
  const input = lineFrom(fd);
  if (!input) return { error: t("budget.errors.invalid") };
  try {
    const r = await addBudgetLine(getDb(), dctx(ctx), input);
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function updateLineAction(eventId: string, lineId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("budget.edit") || !isUuid(lineId)) return { error: t("common.notAllowed") };
  if (payerField(fd) === undefined) return { error: t("payer.invalid") };
  const input = lineFrom(fd);
  if (!input) return { error: t("budget.errors.invalid") };
  try {
    const r = await updateBudgetLine(getDb(), dctx(ctx), lineId, input);
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function deleteLineAction(eventId: string, lineId: string, _p: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("budget.edit") || !isUuid(lineId)) return { error: t("common.notAllowed") };
  try {
    const r = await deleteBudgetLine(getDb(), dctx(ctx), lineId);
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

/** Records a payment against a booking or a standalone cost (PAY-03). */
export async function recordPaymentAction(eventId: string, target: { bookingId?: string; budgetLineId?: string }, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const ids = [target.bookingId, target.budgetLineId].filter((x): x is string => !!x);
  if (!ctx.can("payments.record") || ids.length !== 1 || !ids.every(isUuid)) return { error: t("common.notAllowed") };
  const amount = paiseField(fd, "amount");
  const inv = String(fd.get("invoiceId") ?? "");
  if (!amount || (inv && !isUuid(inv))) return { error: t("payments.errors.invalid") };
  if (payerField(fd) === undefined) return { error: t("payer.invalid") };
  // A Host's payment counts at once, so it needs a fresh one-time code like approving one (EVT-01d).
  if (ctx.decide("payments.record") === "allow" && !hasRecentStepUp(ctx.session)) {
    redirect(`/step-up?next=${encodeURIComponent(target.bookingId ? `/events/${eventId}/vendors/bookings/${target.bookingId}` : `/events/${eventId}/budget/lines`)}`);
  }
  const parsed = paymentInput.safeParse({
    bookingId: target.bookingId ?? null,
    budgetLineId: target.budgetLineId ?? null,
    invoiceId: inv || null,
    paidOn: dateField(fd, "paidOn"),
    amountPaise: amount,
    mode: String(fd.get("mode") ?? ""),
    reference: optStr(fd, "reference"),
    payer: payerField(fd),
    notes: optStr(fd, "notes"),
    allowOverpay: fd.get("allowOverpay") === "on",
  });
  if (!parsed.success) return { error: t("payments.errors.invalid") };
  try {
    const r = await recordPayment(getDb(), dctx(ctx), parsed.data);
    refresh(eventId);
    return { info: r.result.status === "pending" ? t("payments.recorded") : t("payments.confirmedNow") };
  } catch (e) {
    return fail(t, e);
  }
}

export async function deletePaymentAction(eventId: string, paymentId: string, back: string) {
  const ctx = await getEventContext(eventId);
  if (!isUuid(paymentId) || ctx.decide("payments.record") !== "allow") return;
  if (!hasRecentStepUp(ctx.session)) redirect(`/step-up?next=${encodeURIComponent(back.startsWith(`/events/${eventId}/`) ? back : `/events/${eventId}/budget`)}`);
  await deletePayment(getDb(), dctx(ctx), paymentId).catch((e) => {
    if (!(e instanceof PaymentError)) throw e;
  });
  refresh(eventId);
}

/** Invoice form: up to 10 line rows (desc_i, svc_i, hsn_i, amount_i, rate_i). */
export async function createInvoiceAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("invoices.edit")) return { error: t("common.notAllowed") };
  const lines = [];
  for (let i = 0; i < 10; i++) {
    const amount = signedPaiseField(fd, `amount_${i}`);
    const rate = bpsField(fd, `rate_${i}`, 0);
    if (amount === undefined || rate === undefined) return { error: t("payments.errors.invalid") };
    if (amount == null) continue;
    const svc = String(fd.get(`svc_${i}`) ?? "");
    lines.push({
      serviceId: svc && isUuid(svc) ? svc : null,
      description: String(fd.get(`desc_${i}`) ?? "").trim() || "—",
      hsnSac: optStr(fd, `hsn_${i}`),
      amountPaise: amount,
      gstRateBps: rate,
    });
  }
  const vendorId = String(fd.get("vendorId") ?? "");
  const bookingId = String(fd.get("bookingId") ?? "");
  const printed = paiseField(fd, "printedTotal");
  if (printed === undefined) return { error: t("payments.errors.invalid") };
  const parsed = invoiceInput.safeParse({
    vendorId,
    bookingId: bookingId && isUuid(bookingId) ? bookingId : null,
    number: String(fd.get("number") ?? ""),
    invoiceDate: dateField(fd, "invoiceDate"),
    dueDate: dateField(fd, "dueDate"),
    supplierGstin: optStr(fd, "supplierGstin"),
    taxType: ["cgst_sgst", "igst"].includes(String(fd.get("taxType"))) ? String(fd.get("taxType")) : "none",
    printedTotalPaise: printed,
    notes: optStr(fd, "notes"),
    lines,
  });
  if (!parsed.success) return { error: t("payments.errors.invalid") };
  let id: string;
  try {
    id = (await createInvoice(getDb(), eventId, ctx.actor, parsed.data)).id;
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/budget/invoices/${id}?saved=1`);
}

export async function deleteInvoiceAction(eventId: string, invoiceId: string, _p: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("invoices.edit") || !isUuid(invoiceId)) return { error: t("common.notAllowed") };
  try {
    await deleteInvoice(getDb(), eventId, ctx.actor, invoiceId);
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/budget/invoices`);
}

/** Hosts only: approval limits per category, GST state and reminder recipients. */
export async function settingsAction(eventId: string, categoryIds: string[], _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (ctx.decide("budget.thresholds") !== "allow" || !categoryIds.every(isUuid)) return { error: t("budget.thresholdsHostOnly") };
  const db = getDb();
  for (const id of categoryIds) {
    const v = paiseField(fd, `th_${id}`);
    if (v === undefined) return { error: t("budget.errors.invalid") };
    try {
      await setThreshold(db, eventId, ctx.actor, id, v ?? 0);
    } catch (e) {
      return fail(t, e);
    }
  }
  const pos = String(fd.get("placeOfSupply") ?? "");
  const rem = fd.get("paymentRemindersTo") === "hosts" ? "hosts" : "hosts_planners";
  const placeOfSupply = pos in GST_STATES ? pos : null;
  if (placeOfSupply !== ctx.event.placeOfSupply || rem !== ctx.event.paymentRemindersTo) {
    await db.transaction(async (tx) => {
      await tx.update(events).set({ placeOfSupply, paymentRemindersTo: rem }).where(eq(events.id, eventId));
      await audit(tx, { eventId, actor: ctx.actor, action: "event.money_settings", entityType: "event", entityId: eventId, data: { placeOfSupply, paymentRemindersTo: rem } });
    });
  }
  refresh(eventId);
  return { info: t("common.saved") };
}
