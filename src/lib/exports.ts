import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import type { Tx } from "@/db";
import { guests, rsvps, type Payer } from "@/db/schema";
import { formatDay, formatInr, formatWallClock, type Locale, type MessageKey, type Translator } from "@/i18n/core";
import { budgetFacts, byPayer, groupFacts, type Measures } from "./budget";
import { listServiceTypes } from "./catalogue";
import { listFunctions } from "./functions";
import { listGiftItems, type GiftCtx, type GiftRow } from "./gifts";
import { importFields, type ExportLabels } from "./guest-import";
import { listAllGuests } from "./guests";
import { listInvoices, listPayments, type PayableRow } from "./payments";
import { headcounts } from "./rsvp";
import { listItems } from "./runsheet";
import { listTracker } from "./thank-yous";
import { listVendors } from "./vendors";

/**
 * Spreadsheet and printable exports shared by the download routes and the full archive (EVT-08,
 * RPT-02). Framework-free: callers pass a translator. Amounts are in rupees in spreadsheets.
 */

const rupees = { numFmt: "#,##0.00" };
const toBuffer = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());
const sheetName = (name: string, fallback: string) => name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || fallback;

export function payerText(t: Translator, locale: Locale, p: Payer | null | undefined): string {
  if (!p) return t("payer.none");
  if (p.kind === "bride") return t("payer.bride");
  if (p.kind === "groom") return t("payer.groom");
  return p.mode === "percent" ? t("payer.sharedPercent", { bride: p.brideBps / 100 }) : t("payer.sharedFixed", { amount: formatInr(locale, p.bridePaise) });
}

/** Column labels for the guest workbook (`buildGuestWorkbook`). */
export function guestExportLabels(t: Translator): ExportLabels {
  return {
    headers: Object.fromEntries(importFields.map((f) => [f, t(`importer.fields.${f}`)])) as Record<(typeof importFields)[number], string>,
    sides: { bride: t("sides.bride"), groom: t("sides.groom"), both: t("sides.both") },
    ages: { adult: t("ages.adult"), child: t("ages.child"), infant: t("ages.infant") },
    diets: { veg: t("diets.veg"), non_veg: t("diets.non_veg"), jain: t("diets.jain"), vegan: t("diets.vegan"), other: t("diets.other") },
    yes: t("importer.yes"),
    summarySheet: t("importer.sheetSummary"),
    guestsSheet: t("importer.sheetGuests"),
    functionHeader: t("importer.function"),
    invitedHeader: t("importer.invited"),
  };
}

/** RSV-05: headcount summary plus one sheet per function listing attending guests. */
export async function buildHeadcountWorkbook(db: Tx, eventId: string, t: Translator): Promise<Buffer> {
  const [fns, counts, rows] = await Promise.all([listFunctions(db, eventId), headcounts(db, eventId), listAllGuests(db, eventId)]);
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet(t("importer.sheetSummary"));
  const diets = ["veg", "non_veg", "jain", "vegan", "other"] as const;
  summary.columns = [
    { header: t("importer.function"), key: "fn", width: 24 },
    ...(["attending", "maybe", "declined", "pending"] as const).map((k) => ({ header: t(`rsvp.${k}`), key: k, width: 14 })),
    { header: t("ages.adult"), key: "adult", width: 10 },
    { header: t("ages.child"), key: "child", width: 10 },
    { header: t("ages.infant"), key: "infant", width: 10 },
    ...diets.map((d) => ({ header: t(`diets.${d}`), key: d, width: 10 })),
    { header: t("rsvp.unknownDiet"), key: "unknown", width: 12 },
    { header: t("rsvp.allergies"), key: "allergies", width: 16 },
  ];
  summary.getRow(1).font = { bold: true };
  for (const fn of fns) {
    const c = counts.get(fn.id);
    summary.addRow({
      fn: fn.name,
      attending: c?.attending ?? 0,
      maybe: c?.maybe ?? 0,
      declined: c?.declined ?? 0,
      pending: c?.pending ?? 0,
      ...(c?.attendingBy.age ?? {}),
      ...(c?.attendingBy.diet ?? {}),
      allergies: c?.attendingBy.allergies ?? 0,
    });
  }
  const answers = new Map<string, Record<string, string>>();
  const all = await db
    .select({ guestId: rsvps.guestId, functionId: rsvps.functionId, status: rsvps.status })
    .from(rsvps)
    .innerJoin(guests, eq(guests.id, rsvps.guestId))
    .where(eq(guests.eventId, eventId));
  for (const a of all) answers.set(a.guestId, { ...(answers.get(a.guestId) ?? {}), [a.functionId]: a.status });
  for (const fn of fns) {
    const ws = wb.addWorksheet(sheetName(fn.name, "Function"));
    ws.columns = [
      { header: t("importer.fields.household"), key: "h", width: 24 },
      { header: t("importer.fields.name"), key: "n", width: 24 },
      { header: t("importer.fields.side"), key: "s", width: 14 },
      { header: t("importer.fields.ageGroup"), key: "a", width: 10 },
      { header: t("importer.fields.diet"), key: "d", width: 12 },
      { header: t("guestForm.dietNotes"), key: "dn", width: 30 },
      { header: t("rsvp.title"), key: "r", width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const status = answers.get(r.guest.id)?.[fn.id];
      if (status !== "attending" && status !== "maybe") continue;
      ws.addRow({
        h: r.household.name,
        n: r.guest.name,
        s: t(`sides.${r.household.side}`),
        a: t(`ages.${r.guest.ageGroup}`),
        d: r.guest.diet ? t(`diets.${r.guest.diet}`) : "",
        dn: r.guest.dietNotes ?? "",
        r: t(`rsvp.${status}`),
      });
    }
  }
  return toBuffer(wb);
}

/** PAY-06: payables (amounts in rupees). */
export async function buildPayablesWorkbook(rows: PayableRow[], t: Translator, locale: Locale): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName(t("payments.payablesTitle"), "Payables"));
  ws.columns = [
    { header: t("invoices.vendor"), key: "vendor", width: 28 },
    { header: t("bookings.milestoneLabel"), key: "label", width: 20 },
    { header: t("bookings.due"), key: "due", width: 14 },
    { header: t("bookings.amount"), key: "amount", width: 14, style: rupees },
    { header: t("bookings.balance"), key: "remaining", width: 14, style: rupees },
    { header: t("payments.payer"), key: "payer", width: 24 },
    { header: t("payments.statusColumn"), key: "status", width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow({
      vendor: r.vendorName,
      label: r.label || t(`bookings.milestoneKinds.${r.kind}`),
      due: r.dueDate ?? "",
      amount: r.amount / 100,
      remaining: r.remaining / 100,
      payer: payerText(t, locale, r.payer),
      status: t(`payments.status.${r.status}` as MessageKey),
    });
  }
  return toBuffer(wb);
}

/** BGT-05/RPT-02: planned, committed, invoiced and paid by function, category, vendor and payer. */
export async function buildBudgetWorkbook(db: Tx, eventId: string, t: Translator): Promise<Buffer> {
  const [facts, fns, types, vendors] = await Promise.all([
    budgetFacts(db, eventId),
    listFunctions(db, eventId),
    listServiceTypes(db, eventId),
    listVendors(db, eventId, { includeArchived: true }),
  ]);
  const wb = new ExcelJS.Workbook();
  const sheet = (title: string, rows: { label: string; m: Measures | undefined }[]) => {
    const ws = wb.addWorksheet(sheetName(title, "Budget"));
    ws.columns = [
      { header: "", key: "label", width: 30 },
      { header: t("budget.planned"), key: "planned", width: 16, style: rupees },
      { header: t("budget.committed"), key: "committed", width: 16, style: rupees },
      { header: t("budget.invoiced"), key: "invoiced", width: 16, style: rupees },
      { header: t("budget.paid"), key: "paid", width: 16, style: rupees },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      if (!r.m) continue;
      ws.addRow({ label: r.label, planned: r.m.planned / 100, committed: r.m.committed / 100, invoiced: r.m.invoiced / 100, paid: r.m.paid / 100 });
    }
  };
  const byFn = groupFacts(facts, "functionId");
  const byCat = groupFacts(facts, "categoryId");
  const byVendor = groupFacts(facts, "vendorId");
  const payer = byPayer(facts);
  sheet(t("budget.byFunction"), [...fns.map((f) => ({ label: f.name, m: byFn.get(f.id) })), { label: t("budget.noFunction"), m: byFn.get(null) }]);
  sheet(t("budget.byCategory"), [
    ...types.map((ty) => ({ label: ty.systemKey ? t(`catalogue.types.${ty.systemKey}` as MessageKey) : ty.name, m: byCat.get(ty.id) })),
    { label: t("budget.noCategory"), m: byCat.get(null) },
  ]);
  sheet(t("budget.byVendor"), [...vendors.map((v) => ({ label: v.name, m: byVendor.get(v.id) })), { label: t("budget.noVendor"), m: byVendor.get(null) }]);
  sheet(t("budget.byPayer"), [
    { label: t("payer.bride"), m: payer.bride },
    { label: t("payer.groom"), m: payer.groom },
    { label: t("payer.unassigned"), m: payer.unassigned },
  ]);
  return toBuffer(wb);
}

/** PAY-03: every recorded payment. */
export async function buildPaymentsWorkbook(db: Tx, eventId: string, t: Translator, locale: Locale): Promise<Buffer> {
  const [rows, invoices] = await Promise.all([listPayments(db, eventId), listInvoices(db, eventId, "9999-12-31")]);
  const invoiceLabel = new Map(invoices.map((i) => [i.invoice.id, [i.vendorName, i.invoice.number].filter(Boolean).join(" · ")]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName(t("archive.sheets.payments"), "Payments"));
  ws.columns = [
    { header: t("archive.cols.date"), key: "date", width: 14 },
    { header: t("archive.cols.amount"), key: "amount", width: 14, style: rupees },
    { header: t("archive.cols.mode"), key: "mode", width: 14 },
    { header: t("archive.cols.reference"), key: "ref", width: 20 },
    { header: t("archive.cols.payer"), key: "payer", width: 24 },
    { header: t("archive.cols.invoice"), key: "invoice", width: 24 },
    { header: t("archive.cols.status"), key: "state", width: 16 },
    { header: t("archive.cols.recordedBy"), key: "by", width: 20 },
    { header: t("archive.cols.notes"), key: "notes", width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const { payment: p, recordedByName } of rows) {
    ws.addRow({
      date: p.paidOn,
      amount: p.amountPaise / 100,
      mode: t(`archive.paymentModes.${p.mode}` as MessageKey),
      ref: p.reference ?? "",
      payer: payerText(t, locale, p.payer),
      invoice: p.invoiceId ? (invoiceLabel.get(p.invoiceId) ?? "") : "",
      state: t(`archive.paymentStates.${p.state}` as MessageKey),
      by: recordedByName ?? "",
      notes: p.notes ?? "",
    });
  }
  return toBuffer(wb);
}

/** VND-01 directory (no PAN or bank details: those stay encrypted in the app, ADR-0019). */
export async function buildVendorsWorkbook(db: Tx, eventId: string, t: Translator): Promise<Buffer> {
  const [vendors, types] = await Promise.all([listVendors(db, eventId, { includeArchived: true }), listServiceTypes(db, eventId)]);
  const typeName = new Map(types.map((ty) => [ty.id, ty.systemKey ? t(`catalogue.types.${ty.systemKey}` as MessageKey) : ty.name]));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName(t("archive.sheets.vendors"), "Vendors"));
  ws.columns = [
    { header: t("archive.cols.name"), key: "name", width: 28 },
    { header: t("archive.cols.services"), key: "types", width: 30 },
    { header: t("archive.cols.contact"), key: "contact", width: 20 },
    { header: t("archive.cols.phone"), key: "phone", width: 16 },
    { header: t("archive.cols.email"), key: "email", width: 26 },
    { header: t("archive.cols.gstin"), key: "gstin", width: 18 },
    { header: t("archive.cols.rating"), key: "rating", width: 8 },
    { header: t("archive.cols.notes"), key: "notes", width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const v of vendors) {
    ws.addRow({
      name: v.name,
      types: v.typeIds.map((id) => typeName.get(id) ?? "").filter(Boolean).join(", "),
      contact: v.contactName ?? "",
      phone: v.phone ?? "",
      email: v.email ?? "",
      gstin: v.gstin ?? "",
      rating: v.rating ?? "",
      notes: v.notes ?? "",
    });
  }
  return toBuffer(wb);
}

/** "When" for a gift: the function (with its date) and/or the give-by date. */
export function giftWhenText(t: Translator, locale: Locale, g: Pick<GiftRow, "functionName" | "functionDate" | "giveBy">): string {
  const parts: string[] = [];
  if (g.functionName) parts.push(g.functionDate ? `${g.functionName} (${formatDay(locale, g.functionDate)})` : g.functionName);
  if (g.giveBy) parts.push(t("gifts.giveByLine", { date: formatDay(locale, g.giveBy) }));
  return parts.join(" · ");
}

/** GFT-06: the gift list as a sheet (amounts in rupees). */
export function addGiftListSheet(wb: ExcelJS.Workbook, rows: GiftRow[], t: Translator, locale: Locale) {
  const ws = wb.addWorksheet(sheetName(t("archive.sheets.gifts"), "Gifts"));
  ws.columns = [
    { header: t("gifts.cols.gift"), key: "gift", width: 28 },
    { header: t("gifts.cols.category"), key: "category", width: 18 },
    { header: t("gifts.cols.when"), key: "when", width: 30 },
    { header: t("gifts.cols.forWhom"), key: "forWhom", width: 24 },
    { header: t("gifts.cols.families"), key: "families", width: 30 },
    { header: t("gifts.cols.needed"), key: "needed", width: 10 },
    { header: t("gifts.cols.bought"), key: "bought", width: 10 },
    { header: t("gifts.cols.status"), key: "status", width: 14 },
    { header: t("gifts.cols.assignee"), key: "assignee", width: 20 },
    { header: t("gifts.cols.unitCost"), key: "unit", width: 14, style: rupees },
    { header: t("gifts.cols.total"), key: "total", width: 14, style: rupees },
    { header: t("gifts.cols.shop"), key: "shop", width: 24 },
    { header: t("gifts.cols.notes"), key: "notes", width: 30 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const g of rows) {
    ws.addRow({
      gift: g.name,
      category: t(`gifts.categories.${g.category}`),
      when: giftWhenText(t, locale, g),
      forWhom: g.forWhom ?? "",
      families: g.recipients.map((r) => r.name).join(", "),
      needed: g.needed ?? "",
      bought: g.quantityBought,
      status: t(`gifts.statuses.${g.status}`),
      assignee: g.assigneeName ?? "",
      unit: g.unitCostPaise != null ? g.unitCostPaise / 100 : "",
      total: g.totalCostPaise != null ? g.totalCostPaise / 100 : "",
      shop: g.source ?? "",
      notes: g.notes ?? "",
    });
  }
}

/** GFT-06: the gift list download. */
export async function buildGiftListWorkbook(rows: GiftRow[], t: Translator, locale: Locale): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addGiftListSheet(wb, rows, t, locale);
  return toBuffer(wb);
}

/** For the archive (EVT-08): the gift list and the thank-you tracker (GFT-06/08). */
export async function buildGiftsWorkbook(db: Tx, c: GiftCtx, t: Translator, locale: Locale): Promise<Buffer> {
  const [rows, tracker] = await Promise.all([listGiftItems(db, c), listTracker(db, c, {})]);
  const wb = new ExcelJS.Workbook();
  addGiftListSheet(wb, rows, t, locale);
  const ty = wb.addWorksheet(sheetName(t("archive.sheets.thankYous"), "Thank-yous"));
  ty.columns = [
    { header: t("archive.cols.household"), key: "h", width: 28 },
    { header: t("archive.cols.status"), key: "status", width: 16 },
    { header: t("archive.cols.channel"), key: "channel", width: 14 },
    { header: t("archive.cols.sentAt"), key: "sent", width: 20 },
    { header: t("archive.cols.sentBy"), key: "by", width: 20 },
    { header: t("archive.cols.note"), key: "text", width: 50 },
  ];
  ty.getRow(1).font = { bold: true };
  for (const r of tracker) {
    ty.addRow({
      h: r.householdName,
      status: t(`archive.thankYouStatus.${r.status}` as MessageKey),
      channel: r.channel ?? "",
      sent: r.sentAt ? r.sentAt.toISOString().slice(0, 16).replace("T", " ") : "",
      by: r.sentByName ?? "",
      text: r.draftText ?? "",
    });
  }
  return toBuffer(wb);
}

// ---------------------------------------------------------------------------
// Printable HTML (ADR-0015: print to PDF from the browser)
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, locale: Locale) {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:16px;margin-top:24px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f3f3f3}td.n{text-align:right}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}

/** ITN-03/07: every function's run sheet in one printable page. */
export async function buildRunSheetsHtml(db: Tx, eventId: string, t: Translator, locale: Locale): Promise<string> {
  const fns = await listFunctions(db, eventId);
  let body = "";
  for (const fn of fns) {
    const items = await listItems(db, eventId, fn.id);
    body += `<h2>${esc(fn.name)}${fn.date ? ` · ${esc(fn.date)}` : ""}</h2>`;
    if (items.length === 0) {
      body += `<p>${esc(t("archive.none"))}</p>`;
      continue;
    }
    body += `<table><tr><th>${esc(t("archive.cols.time"))}</th><th>${esc(t("archive.cols.minutes"))}</th><th>${esc(t("archive.cols.title"))}</th><th>${esc(t("archive.cols.owner"))}</th><th>${esc(t("archive.cols.location"))}</th><th>${esc(t("archive.cols.notes"))}</th></tr>`;
    for (const { item, ownerUserName, ownerVendorName } of items) {
      const when = formatWallClock(locale, item.startsAt, { timeStyle: "short", timeZone: "UTC" });
      body += `<tr><td>${esc(when)}</td><td class="n">${item.durationMin}</td><td>${esc(item.title)}</td><td>${esc(ownerUserName ?? ownerVendorName ?? item.ownerName ?? "")}</td><td>${esc(item.location ?? "")}</td><td>${esc(item.notes ?? "")}</td></tr>`;
    }
    body += "</table>";
  }
  return page(t("archive.runSheetsTitle"), body, locale);
}

/** PAY-01: invoices with GST and payment status, printable. */
export async function buildInvoicesHtml(db: Tx, eventId: string, t: Translator, locale: Locale, today: string): Promise<string> {
  const rows = await listInvoices(db, eventId, today);
  const inr = (p: number) => esc(formatInr(locale, p));
  let body = `<table><tr><th>${esc(t("archive.cols.vendor"))}</th><th>${esc(t("archive.cols.invoice"))}</th><th>${esc(t("archive.cols.date"))}</th><th>${esc(t("archive.cols.due"))}</th><th>${esc(t("archive.cols.gstin"))}</th><th>${esc(t("archive.cols.subtotal"))}</th><th>${esc(t("archive.cols.gst"))}</th><th>${esc(t("archive.cols.total"))}</th><th>${esc(t("archive.cols.paid"))}</th><th>${esc(t("archive.cols.status"))}</th></tr>`;
  for (const r of rows) {
    const i = r.invoice;
    body += `<tr><td>${esc(r.vendorName)}</td><td>${esc(i.number ?? "")}</td><td>${esc(i.invoiceDate ?? "")}</td><td>${esc(i.dueDate ?? "")}</td><td>${esc(i.supplierGstin ?? "")}</td><td class="n">${inr(i.subtotalPaise)}</td><td class="n">${inr(i.cgstPaise + i.sgstPaise + i.igstPaise)}</td><td class="n">${inr(i.totalPaise)}</td><td class="n">${inr(r.paid)}</td><td>${esc(t(`payments.status.${r.status}` as MessageKey))}</td></tr>`;
  }
  body += "</table>";
  if (rows.length === 0) body = `<p>${esc(t("archive.none"))}</p>`;
  return page(t("archive.invoicesTitle"), body, locale);
}
