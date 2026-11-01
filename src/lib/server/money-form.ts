import "server-only";
import type { Payer } from "@/db/schema";
import { formatInr, type Locale, type MessageKey, type Translator } from "@/i18n/core";
import type { SubmitResult } from "../approvals";
import { rupeesToPaise, percentToBps } from "../money";
import { payerFromForm } from "../services";
import { todayIn } from "../tasks";

const str = (fd: FormData, name: string) => String(fd.get(name) ?? "").trim();
export const optStr = (fd: FormData, name: string) => str(fd, name) || null;

/** Rupees field -> paise; empty -> null; invalid -> undefined. */
export function paiseField(fd: FormData, name: string): number | null | undefined {
  const v = str(fd, name);
  if (v === "") return null;
  return rupeesToPaise(v) ?? undefined;
}

/** Signed rupees (package discounts may be negative). */
export function signedPaiseField(fd: FormData, name: string): number | null | undefined {
  const v = str(fd, name);
  if (v === "") return null;
  const neg = v.startsWith("-");
  const p = rupeesToPaise(neg ? v.slice(1) : v);
  return p == null ? undefined : neg ? -p : p;
}

export function intField(fd: FormData, name: string): number | null | undefined {
  const v = str(fd, name);
  if (v === "") return null;
  return /^\d{1,7}$/.test(v) ? Number(v) : undefined;
}

export function bpsField(fd: FormData, name: string, fallback = 0): number | undefined {
  const v = str(fd, name);
  if (v === "") return fallback;
  return percentToBps(v) ?? undefined;
}

export const dateField = (fd: FormData, name: string) => {
  const v = str(fd, name);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

export function payerField(fd: FormData, prefix = "payer"): Payer | null | undefined {
  return payerFromForm(str(fd, `${prefix}Kind`), str(fd, `${prefix}Mode`), str(fd, `${prefix}Value`));
}

export function payerText(t: Translator, locale: Locale, p: Payer | null | undefined): string {
  if (!p) return t("payer.none");
  if (p.kind === "bride") return t("payer.bride");
  if (p.kind === "groom") return t("payer.groom");
  return p.mode === "percent" ? t("payer.sharedPercent", { bride: p.brideBps / 100 }) : t("payer.sharedFixed", { amount: formatInr(locale, p.bridePaise) });
}

export function typeLabel(t: Translator, s: { typeKey: string | null; typeName: string }) {
  return s.typeKey ? t(`catalogue.types.${s.typeKey}` as MessageKey) : s.typeName;
}

export function serviceLabel(t: Translator, s: { typeKey: string | null; typeName: string; name: string | null }) {
  const type = typeLabel(t, s);
  return s.name ? `${type} · ${s.name}` : type;
}

/** Feedback after a change that may have gone to a Host. */
export function resultInfo(t: Translator, r: SubmitResult): string {
  if (r.status === "pending") return t("services.submitted");
  return r.status === "applied" && r.auto ? t("services.autoApproved") : t("common.saved");
}

export const eventToday = (tz: string) => todayIn(tz);

export function payerLabels(t: Translator) {
  return {
    label: t("payer.label"),
    none: t("payer.none"),
    bride: t("payer.bride"),
    groom: t("payer.groom"),
    shared: t("payer.shared"),
    splitPercent: t("payer.splitPercent"),
    splitFixed: t("payer.splitFixed"),
    brideShare: t("payer.brideShare"),
    brideShareHelp: t("payer.brideShareHelp"),
  };
}

export const statusTone = {
  proposed: "warning",
  rejected: "danger",
  cancelled: "neutral",
  delivered: "success",
  booked: "success",
  partially_booked: "primary",
  quoting: "primary",
  open: "neutral",
  empty: "neutral",
} as const;

export const payTone = { paid: "success", overdue: "danger", partially_paid: "warning", due: "warning", upcoming: "neutral" } as const;

/** Domain context (event, actor, policy subject) from the page/action's event context. */
export const dctx = (ctx: { event: { id: string }; actor: import("../audit").Actor; subject: import("../policy").PolicySubject }) => ({
  eventId: ctx.event.id,
  actor: ctx.actor,
  subject: ctx.subject,
});

export function requirementLabels(t: Translator) {
  return {
    title: t("services.reqTitle"),
    quantity: t("services.quantity"),
    unit: t("services.unit"),
    specs: t("services.specs"),
    startsAt: t("services.startsAt"),
    endsAt: t("services.endsAt"),
    timesHelp: t("services.timesHelp"),
    venue: t("services.venue"),
    venueHelp: t("services.venueHelp"),
    estimate: t("services.estimate"),
    priority: t("services.priority"),
    must: t("services.priorities.must"),
    nice: t("services.priorities.nice"),
    payer: payerLabels(t),
  };
}

/** Labels for DocumentsPanel, with the result of the last upload (?doc=ok / ?docError=code). */
export function documentLabels(t: Translator, title: string, sp: { doc?: string | string[]; docError?: string | string[] }) {
  const code = typeof sp.docError === "string" && ["not_found", "too_large", "bad_type", "quota", "invalid"].includes(sp.docError) ? sp.docError : null;
  return {
    title,
    upload: t("documents.upload"),
    file: t("documents.file"),
    kind: t("documents.kind"),
    help: t("documents.help"),
    empty: t("documents.empty"),
    remove: t("common.remove"),
    deleteConfirm: t("documents.deleteConfirm"),
    kinds: {
      contract: t("documents.kinds.contract"),
      quote: t("documents.kinds.quote"),
      invoice: t("documents.kinds.invoice"),
      receipt: t("documents.kinds.receipt"),
      brief: t("documents.kinds.brief"),
      other: t("documents.kinds.other"),
    },
    error: code ? t(`documents.errors.${code}` as MessageKey) : undefined,
    saved: sp.doc === "ok" ? t("common.saved") : undefined,
  };
}

export function vendorLabels(t: Translator) {
  return {
    name: t("vendors.name"),
    contactName: t("vendors.contactName"),
    phone: t("vendors.phone"),
    email: t("vendors.email"),
    gstin: t("vendors.gstin"),
    gstinHelp: t("vendors.gstinHelp"),
    services: t("vendors.services"),
    notes: t("vendors.notes"),
  };
}

export function paymentLabels(t: Translator) {
  return {
    paidOn: t("payments.paidOn"),
    amount: t("payments.amount"),
    mode: t("payments.mode"),
    reference: t("payments.reference"),
    invoice: t("payments.invoice"),
    noInvoice: t("payments.noInvoice"),
    notes: t("payments.notes"),
    allowOverpay: t("payments.allowOverpay"),
    modes: { upi: t("payments.modes.upi"), bank: t("payments.modes.bank"), cheque: t("payments.modes.cheque"), cash: t("payments.modes.cash"), card: t("payments.modes.card") },
    payer: { ...payerLabels(t), label: t("payments.payer") },
  };
}

/** End of a payables period ("week" = 7 days, "month" = 31 days from today; "all" = none). */
export function periodEnd(today: string, period: string): string | null {
  const d = new Date(`${today}T00:00:00Z`);
  if (period === "week") d.setUTCDate(d.getUTCDate() + 7);
  else if (period === "month") d.setUTCDate(d.getUTCDate() + 31);
  else return null;
  return d.toISOString().slice(0, 10);
}
