import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { functionInvites, guestImports, guests, households, rsvps, type AgeGroup, type Diet, type RsvpStatus, type Side } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { freezeDueLocks } from "./caterer-headcount";
import { listFunctions } from "./functions";
import { normalizeEmail, normalizePhone, normalizeTags } from "./guests";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export class ImportError extends Error {
  constructor(public code: "unsupported" | "empty" | "too_many_rows" | "too_large" | "not_found" | "no_name_column" | "already_done" | "bad_setting") {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF, embedded newlines). */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const delimiter = (text.split(/\r?\n/, 1)[0].match(/;/g)?.length ?? 0) > (text.split(/\r?\n/, 1)[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((r) => r.text).join("");
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("hyperlink" in value) return String(value.hyperlink).replace(/^mailto:/, "");
  }
  return String(value);
}

/** Reads the first sheet of an .xlsx or a .csv into header + rows (all strings, trimmed). */
export async function parseSpreadsheet(data: ArrayBuffer, filename: string): Promise<{ headers: string[]; rows: string[][] }> {
  if (data.byteLength > MAX_IMPORT_BYTES) throw new ImportError("too_large");
  let table: string[][];
  if (/\.csv$/i.test(filename)) {
    table = parseCsv(new TextDecoder("utf-8").decode(data));
  } else if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(data);
    } catch {
      throw new ImportError("unsupported");
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw new ImportError("empty");
    table = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let c = 1; c <= sheet.columnCount; c++) cells.push(cellText(row.getCell(c).value));
      table.push(cells);
    });
  } else {
    throw new ImportError("unsupported");
  }
  table = table.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));
  if (table.length < 2) throw new ImportError("empty");
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new ImportError("too_many_rows");
  const width = Math.max(...table.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => table[0][i] || `Column ${i + 1}`);
  const rows = table.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export const importFields = [
  "name",
  "household",
  "side",
  "relation",
  "phone",
  "email",
  "ageGroup",
  "diet",
  "tags",
  "address",
  "city",
  "postalCode",
  "notes",
  "isHead",
  "functions",
  "rsvp",
] as const;
export type ImportField = (typeof importFields)[number];
export type ColumnMapping = Partial<Record<ImportField, number>>;

const synonyms: Record<ImportField, string[]> = {
  name: ["name", "guest name", "full name", "guest", "person", "नाम", "मेहमान"],
  household: ["household", "family", "family name", "group", "party", "invite", "परिवार", "घर"],
  side: ["side", "bride/groom", "bride or groom", "पक्ष", "पक्ष (वर/वधू)"],
  relation: ["relation", "relationship", "रिश्ता", "संबंध"],
  phone: ["phone", "mobile", "mobile number", "phone number", "contact", "whatsapp", "cell", "मोबाइल", "फ़ोन", "फोन"],
  email: ["email", "e-mail", "email address", "mail", "ईमेल"],
  ageGroup: ["age group", "age", "adult/child", "category", "उम्र", "आयु"],
  diet: ["diet", "food", "meal", "food preference", "meal preference", "veg/non-veg", "भोजन", "खाना"],
  tags: ["tags", "tag", "labels", "groups", "टैग"],
  address: ["address", "postal address", "पता"],
  city: ["city", "town", "शहर"],
  postalCode: ["pincode", "pin code", "pin", "postal code", "zip", "पिन कोड"],
  notes: ["notes", "note", "comments", "remarks", "नोट"],
  isHead: ["head", "head of family", "primary", "main contact", "मुखिया"],
  functions: ["functions", "events", "invited to", "function", "कार्यक्रम", "रस्में"],
  rsvp: ["rsvp", "rsvp status", "response", "reply", "जवाब", "आरएसवीपी"],
};
/** Short words that only count as an exact header ("Status", not "Travel status"). */
const exactOnly: Partial<Record<ImportField, string[]>> = { rsvp: ["status"] };

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[_*:]/g, " ").replace(/\s+/g, " ").trim();
/** Case- and space-insensitive key for matching a header to a function name. */
const fnKey = (s: string) => norm(s).replace(/\s*[(\[-]?\s*(rsvp|response|reply|जवाब)\s*[)\]]?$/, "").replace(/\s+/g, "");

/** Guesses which column holds which field from the header names (skipping `exclude` columns). */
export function guessMapping(headers: string[], exclude: Iterable<number> = []): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>(exclude);
  for (const field of importFields) {
    const options = synonyms[field];
    const exact = [...options, ...(exactOnly[field] ?? [])];
    let idx = headers.findIndex((h, i) => !used.has(i) && exact.includes(norm(h)));
    if (idx < 0) idx = headers.findIndex((h, i) => !used.has(i) && options.some((o) => o.length > 3 && norm(h).includes(o)));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  return mapping;
}

/** Columns whose header is a function's name ("Sangeet", "sangeet rsvp", "हल्दी"), by function id. */
export function guessFunctionColumns(headers: string[], fns: { id: string; name: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const fn of fns) {
    const key = fnKey(fn.name);
    if (!key) continue;
    const idx = headers.findIndex((h, i) => !used.has(i) && fnKey(h) === key);
    if (idx >= 0) {
      out[fn.id] = idx;
      used.add(idx);
    }
  }
  return out;
}

/**
 * Everything chosen on the mapping screen. Stored in `guest_imports.mapping` as one flat record:
 * field names → column, `fn:<functionId>` → column, `all:<functionId>` → 1, `updateExisting` → 0/1.
 */
export type ImportSettings = {
  mapping: ColumnMapping;
  /** Per-function columns (GST-04): function id → column index. */
  functionColumns: Record<string, number>;
  /**
   * How each function column is read: "replies" (Yes = attending, Maybe, No = not attending) or
   * "invites" (Yes/x/✓ = invited, No/blank = not invited). Missing = detected from the column.
   */
  functionColumnModes?: Record<string, ColumnMode>;
  /** "Invite everyone in this file to": function ids. */
  inviteAll: string[];
  /** Update invitations/RSVPs of rows that match existing guests; null = default (on when the file has invite/RSVP data). */
  updateExisting: boolean | null;
};
export type StoredMapping = Record<string, number>;
export type ColumnMode = "replies" | "invites";

export function encodeSettings(s: ImportSettings): StoredMapping {
  const out: StoredMapping = { ...s.mapping } as StoredMapping;
  for (const [id, col] of Object.entries(s.functionColumns)) out[`fn:${id}`] = col;
  for (const [id, mode] of Object.entries(s.functionColumnModes ?? {})) out[`fnmode:${id}`] = mode === "replies" ? 1 : 0;
  for (const id of s.inviteAll) out[`all:${id}`] = 1;
  if (s.updateExisting !== null) out.updateExisting = s.updateExisting ? 1 : 0;
  return out;
}

/** Reads stored settings, keeping only this event's functions and real columns. */
export function decodeSettings(stored: StoredMapping | ImportSettings, fns: { id: string }[], width = Infinity): ImportSettings {
  if ("mapping" in stored && typeof stored.mapping === "object") {
    return decodeSettings(encodeSettings(stored as ImportSettings), fns, width);
  }
  const flat = stored as StoredMapping;
  const valid = new Set(fns.map((f) => f.id));
  const col = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < width ? (v as number) : undefined);
  const mapping: ColumnMapping = {};
  for (const f of importFields) {
    const c = col(flat[f]);
    if (c !== undefined) mapping[f] = c;
  }
  const functionColumns: Record<string, number> = {};
  const inviteAll: string[] = [];
  const functionColumnModes: Record<string, ColumnMode> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (k.startsWith("fn:") && valid.has(k.slice(3)) && col(v) !== undefined) functionColumns[k.slice(3)] = v;
    if (k.startsWith("fnmode:") && valid.has(k.slice(7)) && (v === 0 || v === 1)) functionColumnModes[k.slice(7)] = v === 1 ? "replies" : "invites";
    if (k.startsWith("all:") && valid.has(k.slice(4)) && v === 1) inviteAll.push(k.slice(4));
  }
  return { mapping, functionColumns, functionColumnModes, inviteAll, updateExisting: flat.updateExisting === undefined ? null : flat.updateExisting === 1 };
}

/** Whether the file says anything about invitations or replies (the "update existing" default). */
export function hasInviteData(s: ImportSettings) {
  return s.mapping.functions !== undefined || s.mapping.rsvp !== undefined || Object.keys(s.functionColumns).length > 0 || s.inviteAll.length > 0;
}

// ---------------------------------------------------------------------------
// Value normalisation
// ---------------------------------------------------------------------------

export function parseSide(raw: string): Side | null {
  const v = norm(raw);
  if (!v) return null;
  if (/(bride|girl|ladki|vadhu|dulhan|कन्या|वधू|दुल्हन|लड़की)/.test(v)) return "bride";
  if (/(groom|boy|ladka|ladke|var\b|dulha|वर|दूल्हा|लड़का)/.test(v)) return "groom";
  if (/(both|mutual|common|shared|दोनों)/.test(v)) return "both";
  return null;
}

export function parseAgeGroup(raw: string): AgeGroup | null {
  const v = norm(raw);
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const age = Number(v);
    return age < 3 ? "infant" : age < 13 ? "child" : "adult";
  }
  if (/(infant|baby|toddler|शिशु)/.test(v)) return "infant";
  if (/(child|kid|minor|बच्चा|बच्चे|बालक)/.test(v)) return "child";
  if (/(adult|senior|elder|वयस्क|बड़े)/.test(v)) return "adult";
  return null;
}

export function parseDiet(raw: string): { diet: Diet | null; notes: string | null } {
  const v = norm(raw);
  if (!v) return { diet: null, notes: null };
  if (/jain|जैन/.test(v)) return { diet: "jain", notes: null };
  if (/vegan/.test(v)) return { diet: "vegan", notes: null };
  if (/(non[ -]?veg|non[ -]?vegetarian|nv\b|मांसाहारी)/.test(v)) return { diet: "non_veg", notes: null };
  if (/(^veg|vegetarian|शाकाहारी)/.test(v)) return { diet: "veg", notes: null };
  return { diet: "other", notes: raw.trim().slice(0, 200) };
}

const truthy = (raw: string) => /^(y|yes|true|1|x|✓|head|हाँ|हां)$/i.test(raw.trim());

const rsvpWords: [RsvpStatus | "invited", string[]][] = [
  ["attending", ["attending", "attend", "will attend", "yes", "y", "coming", "confirmed", "हाँ", "हां", "आएंगे", "आएँगे", "आ रहे हैं", "आएगा", "आएगी"]],
  ["maybe", ["maybe", "may be", "tentative", "not sure", "शायद", "पक्का नहीं"]],
  ["declined", ["no", "n", "not attending", "not coming", "declined", "decline", "regrets", "नहीं", "ना", "नहीं आएंगे", "नहीं आएँगे", "नहीं आ पाएंगे", "नहीं आ पाएँगे"]],
  ["invited", ["invited", "invite", "x", "✓", "✔", "1", "true", "pending", "no reply yet", "आमंत्रित", "बुलावा", "अभी जवाब नहीं"]],
];
const rsvpLookup = new Map(rsvpWords.flatMap(([k, words]) => words.map((w) => [w, k] as const)));

/**
 * A cell of a function column or the RSVP column: blank → null (no change); otherwise whether
 * it invites and which reply it records, or "unknown" for anything else.
 */
export function parseRsvpCell(raw: string): { status: RsvpStatus | null } | null | "unknown" {
  const v = norm(raw.replace(/️/g, "")).replace(/[.!।]+$/, "").trim();
  if (!v) return null;
  const k = rsvpLookup.get(v);
  if (!k) return "unknown";
  return { status: k === "invited" ? null : k };
}

/** Words that can only be a reply (not a plain "invited" tick), for detecting a column's meaning. */
const replyOnlyWords = new Set(
  rsvpWords.flatMap(([k, words]) => (k === "invited" ? [] : words)).filter((w) => !["yes", "y", "no", "n", "हाँ", "हां", "नहीं", "ना"].includes(w)),
);
const cellKey = (raw: string) => norm(raw.replace(/\uFE0F/g, "")).replace(/[.!।]+$/, "").trim();

/**
 * Whether a function column holds replies or invitations: replies when the header says so
 * (RSVP, reply, response, जवाब) or any cell is a reply-only word (maybe, attending, declined, शायद…).
 */
export function detectColumnMode(header: string, cells: string[]): ColumnMode {
  if (/(rsvp|reply|response|जवाब)/i.test(header)) return "replies";
  return cells.some((c) => replyOnlyWords.has(cellKey(c))) ? "replies" : "invites";
}

const invitationNo = new Set(["no", "n", "0", "false", "नहीं", "ना", "not invited"]);

/**
 * A cell of a function column read as invitations: Yes/x/✓/1 (and any reply word) → invited,
 * No/0/blank → nothing, anything else → "unknown". Never records a reply.
 */
export function parseInviteCell(raw: string): { status: null } | null | "unknown" {
  const v = cellKey(raw);
  if (!v || invitationNo.has(v)) return null;
  const k = rsvpLookup.get(v);
  if (!k || k === "declined") return "unknown";
  return { status: null };
}

// ---------------------------------------------------------------------------
// Preview (validation + duplicates)
// ---------------------------------------------------------------------------

export type RowIssue =
  | { kind: "error"; code: "missingName" }
  | { kind: "warning"; code: "phoneInvalid" | "emailInvalid" | "sideUnknown" | "ageUnknown"; value: string }
  | { kind: "warning"; code: "functionUnknown"; value: string }
  | { kind: "warning"; code: "rsvpUnknown"; value: string; column: string }
  | { kind: "warning"; code: "rsvpNoFunction"; value: string }
  | { kind: "skip"; code: "duplicateInFile"; row: number }
  | { kind: "skip"; code: "alreadyInList"; name: string }
  | { kind: "info"; code: "updateExisting"; name: string };

export type RowAction = "create" | "update" | "skip" | "error";
export type RsvpChange = { functionId: string; newInvite: boolean; from: RsvpStatus | null; to: RsvpStatus | null };

export type PreviewRow = {
  row: number; // 1-based spreadsheet row number (header is row 1)
  action: RowAction;
  householdKey: string;
  householdName: string;
  side: Side;
  name: string;
  relation: string | null;
  phone: string | null;
  email: string | null;
  ageGroup: AgeGroup;
  diet: Diet | null;
  dietNotes: string | null;
  tags: string[];
  address: string | null;
  city: string | null;
  postalCode: string | null;
  notes: string | null;
  isHead: boolean;
  /** Functions this row is invited to (new guests) or should be invited to (existing guests). */
  functionIds: string[];
  /** Replies the file gives, per function. */
  rsvps: { functionId: string; status: RsvpStatus }[];
  /** For "update" rows: the matched guest and what will change. */
  existingGuestId: string | null;
  changes: RsvpChange[];
  issues: RowIssue[];
};

export type ImportPreview = {
  rows: PreviewRow[];
  importable: number;
  updates: number;
  rsvps: number;
  skipped: number;
  errors: number;
  warnings: number;
  households: number;
  updateExisting: boolean;
  /** How each mapped function column was read (chosen or detected). */
  columnModes: Record<string, ColumnMode>;
};

export type ExistingGuest = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  householdName: string;
  householdId?: string;
  functionIds: string[];
  rsvp: Record<string, RsvpStatus>;
};

export function buildPreview(
  rows: string[][],
  input: StoredMapping | ImportSettings,
  existing: (Omit<ExistingGuest, "id" | "functionIds" | "rsvp"> & Partial<ExistingGuest>)[],
  fns: { id: string; name: string }[],
  headers: string[] = [],
): ImportPreview {
  const settings = decodeSettings(input, fns);
  const { mapping } = settings;
  if (mapping.name === undefined) throw new ImportError("no_name_column");
  const updateExisting = settings.updateExisting ?? hasInviteData(settings);
  const get = (r: string[], f: ImportField) => (mapping[f] === undefined ? "" : (r[mapping[f]!] ?? "").trim());
  const fnByName = new Map(fns.map((f) => [norm(f.name), f.id]));
  const fnOrder = new Map(fns.map((f, i) => [f.id, i]));
  const fnCols = Object.entries(settings.functionColumns);
  const header = (c: number) => headers[c] ?? `#${c + 1}`;

  // How each function column is read: chosen on the mapping screen, otherwise detected.
  const columnModes: Record<string, ColumnMode> = {};
  for (const [fnId, c] of fnCols) {
    columnModes[fnId] = settings.functionColumnModes?.[fnId] ?? detectColumnMode(header(c), rows.map((r) => r[c] ?? ""));
  }

  type Known = (typeof existing)[number];
  const index = (key: (g: Known) => string | null) => {
    const m = new Map<string, Known[]>();
    for (const g of existing) {
      const k = key(g);
      if (k) m.set(k, [...(m.get(k) ?? []), g]);
    }
    return m;
  };
  const existingPhones = index((g) => g.phone);
  const existingEmails = index((g) => g.email);
  const existingNames = index((g) => `${norm(g.householdName)}|${norm(g.name)}`);
  const seenPhones = new Map<string, number>();
  const seenEmails = new Map<string, number>();
  const seenNames = new Map<string, number>();
  /** Existing guests already updated by an earlier row → that row. */
  const matchedRows = new Map<string, number>();

  const out: PreviewRow[] = rows.map((r, i) => {
    const rowNo = i + 2;
    const issues: RowIssue[] = [];
    const name = get(r, "name").replace(/\s+/g, " ");
    if (!name) issues.push({ kind: "error", code: "missingName" });

    const rawSide = get(r, "side");
    const side = parseSide(rawSide);
    if (rawSide && !side) issues.push({ kind: "warning", code: "sideUnknown", value: rawSide });

    const rawAge = get(r, "ageGroup");
    const age = parseAgeGroup(rawAge);
    if (rawAge && !age) issues.push({ kind: "warning", code: "ageUnknown", value: rawAge });

    const rawPhone = get(r, "phone");
    const phone = normalizePhone(rawPhone);
    if (phone === "invalid") issues.push({ kind: "warning", code: "phoneInvalid", value: rawPhone });
    const rawEmail = get(r, "email");
    const email = normalizeEmail(rawEmail);
    if (email === "invalid") issues.push({ kind: "warning", code: "emailInvalid", value: rawEmail });

    // Invitations: "invite everyone" + the functions column + per-function columns.
    const invited = new Set<string>(settings.inviteAll);
    for (const fnName of get(r, "functions").split(/[,;/]/).map((s) => s.trim()).filter(Boolean)) {
      const id = fnByName.get(norm(fnName));
      if (id) invited.add(id);
      else issues.push({ kind: "warning", code: "functionUnknown", value: fnName });
    }
    const replies = new Map<string, RsvpStatus>();
    for (const [fnId, c] of fnCols) {
      const raw = (r[c] ?? "").trim();
      const cell = columnModes[fnId] === "replies" ? parseRsvpCell(raw) : parseInviteCell(raw);
      if (cell === "unknown") issues.push({ kind: "warning", code: "rsvpUnknown", value: raw, column: header(c) });
      else if (cell) {
        invited.add(fnId);
        if (cell.status) replies.set(fnId, cell.status);
      }
    }
    const rawRsvp = get(r, "rsvp");
    const generic = parseRsvpCell(rawRsvp);
    if (generic === "unknown") issues.push({ kind: "warning", code: "rsvpUnknown", value: rawRsvp, column: header(mapping.rsvp!) });
    const genericStatus = generic && generic !== "unknown" ? generic.status : null;

    const householdName = get(r, "household") || name;
    const { diet, notes: dietNotes } = parseDiet(get(r, "diet"));

    // Duplicates: an earlier row in the file, or someone already on the guest list.
    const validPhone = phone && phone !== "invalid" ? phone : null;
    const validEmail = email && email !== "invalid" ? email : null;
    const nameKey = `${norm(householdName)}|${norm(name)}`;
    let existingGuestId: string | null = null;
    let changes: RsvpChange[] = [];
    // Functions the generic RSVP column applies to: this row's invitations, plus (for a matched
    // guest) the functions they're already invited to.
    const genericTargets = new Set(invited);
    if (name) {
      const firstRow =
        (validPhone && seenPhones.get(validPhone)) || (validEmail && seenEmails.get(validEmail)) || seenNames.get(nameKey);
      if (firstRow) issues.push({ kind: "skip", code: "duplicateInFile", row: firstRow });
      else {
        const byPhone = validPhone ? (existingPhones.get(validPhone) ?? []) : [];
        const byEmail = validEmail ? (existingEmails.get(validEmail) ?? []) : [];
        const byName = existingNames.get(nameKey) ?? [];
        // Only the same person may be updated: same family + name, or a phone/email that belongs to
        // exactly one guest whose name agrees. Families often share one mobile number.
        const sameName = (g: Known) => norm(g.name) === norm(name);
        const target =
          (byName.length === 1 && byName[0]) ||
          (byPhone.length === 1 && sameName(byPhone[0]) && byPhone[0]) ||
          (byEmail.length === 1 && sameName(byEmail[0]) && byEmail[0]) ||
          null;
        const possible = byPhone[0] ?? byEmail[0] ?? byName[0];
        const earlier = target?.id ? matchedRows.get(target.id) : undefined;
        if (earlier) issues.push({ kind: "skip", code: "duplicateInFile", row: earlier });
        else if (target && updateExisting && target.id) {
          for (const id of target.functionIds ?? []) genericTargets.add(id);
          const has = new Set(target.functionIds ?? []);
          const wanted = [...new Set([...invited, ...(genericStatus ? genericTargets : [])])];
          changes = wanted
            .sort((a, b) => (fnOrder.get(a) ?? 0) - (fnOrder.get(b) ?? 0))
            .map((functionId) => {
              const from = target.rsvp?.[functionId] ?? null;
              const to = replies.get(functionId) ?? genericStatus ?? from;
              return { functionId, newInvite: !has.has(functionId), from, to };
            })
            .filter((c) => c.newInvite || c.to !== c.from);
          if (changes.length) {
            existingGuestId = target.id;
            matchedRows.set(target.id, rowNo);
            issues.push({ kind: "info", code: "updateExisting", name: target.name });
          } else issues.push({ kind: "skip", code: "alreadyInList", name: target.name });
        } else if (target ?? possible) issues.push({ kind: "skip", code: "alreadyInList", name: (target ?? possible)!.name });
      }
      if (validPhone && !seenPhones.has(validPhone)) seenPhones.set(validPhone, rowNo);
      if (validEmail && !seenEmails.has(validEmail)) seenEmails.set(validEmail, rowNo);
      if (!seenNames.has(nameKey)) seenNames.set(nameKey, rowNo);
    }

    // The generic RSVP column fills in every invited function without its own reply.
    if (genericStatus) {
      if (genericTargets.size === 0) issues.push({ kind: "warning", code: "rsvpNoFunction", value: rawRsvp });
      for (const fnId of invited) if (!replies.has(fnId)) replies.set(fnId, genericStatus);
    }
    const functionIds = [...invited].sort((a, b) => (fnOrder.get(a) ?? 0) - (fnOrder.get(b) ?? 0));
    const rsvps = functionIds.filter((id) => replies.has(id)).map((functionId) => ({ functionId, status: replies.get(functionId)! }));

    const action: RowAction = issues.some((x) => x.kind === "error")
      ? "error"
      : issues.some((x) => x.kind === "skip")
        ? "skip"
        : existingGuestId
          ? "update"
          : "create";

    return {
      row: rowNo,
      action,
      householdKey: norm(householdName),
      householdName,
      side: side ?? "both",
      name,
      relation: get(r, "relation") || null,
      phone: validPhone,
      email: validEmail,
      ageGroup: age ?? "adult",
      diet,
      dietNotes,
      tags: normalizeTags(get(r, "tags")),
      address: get(r, "address") || null,
      city: get(r, "city") || null,
      postalCode: get(r, "postalCode") || null,
      notes: get(r, "notes") || null,
      isHead: truthy(get(r, "isHead")),
      functionIds,
      rsvps,
      existingGuestId,
      changes,
      issues,
    };
  });

  const importable = out.filter((r) => r.action === "create");
  const updates = out.filter((r) => r.action === "update");
  return {
    rows: out,
    importable: importable.length,
    updates: updates.length,
    rsvps: importable.reduce((n, r) => n + r.rsvps.length, 0) + updates.reduce((n, r) => n + r.changes.filter((c) => c.to && c.to !== c.from).length, 0),
    skipped: out.filter((r) => r.action === "skip").length,
    errors: out.filter((r) => r.action === "error").length,
    warnings: out.filter((r) => r.issues.some((i) => i.kind === "warning")).length,
    households: new Set(importable.map((r) => r.householdKey)).size,
    updateExisting,
    columnModes,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Guessed settings for a new upload: function-name columns first, then the usual fields. */
export function guessSettings(headers: string[], fns: { id: string; name: string }[]): ImportSettings {
  const functionColumns = guessFunctionColumns(headers, fns);
  return { mapping: guessMapping(headers, Object.values(functionColumns)), functionColumns, inviteAll: [], updateExisting: null };
}

export async function createImport(db: Tx, eventId: string, userId: string, filename: string, parsed: { headers: string[]; rows: string[][] }) {
  const fns = await listFunctions(db, eventId);
  const [row] = await db
    .insert(guestImports)
    .values({
      eventId,
      createdBy: userId,
      filename: filename.slice(0, 200),
      headers: parsed.headers,
      rows: parsed.rows,
      mapping: encodeSettings(guessSettings(parsed.headers, fns)),
    })
    .returning();
  return row;
}

export async function getImport(db: Tx, eventId: string, importId: string) {
  const [row] = await db
    .select()
    .from(guestImports)
    .where(and(eq(guestImports.id, importId), eq(guestImports.eventId, eventId)));
  if (!row) throw new ImportError("not_found");
  return row;
}

/**
 * Saves the mapping screen. Function ids must belong to this event and columns must exist,
 * since they come from a form (`bad_setting` otherwise).
 */
export async function saveImportSettings(db: Tx, eventId: string, importId: string, settings: ImportSettings) {
  const imp = await getImport(db, eventId, importId);
  if (imp.completedAt) throw new ImportError("already_done");
  const fns = await listFunctions(db, eventId);
  const valid = new Set(fns.map((f) => f.id));
  const width = imp.headers.length;
  const okCol = (c: number) => Number.isInteger(c) && c >= 0 && c < width;
  if (
    Object.values(settings.mapping).some((c) => !okCol(c!)) ||
    Object.entries(settings.functionColumns).some(([id, c]) => !valid.has(id) || !okCol(c)) ||
    Object.entries(settings.functionColumnModes ?? {}).some(([id, m]) => !valid.has(id) || (m !== "replies" && m !== "invites")) ||
    settings.inviteAll.some((id) => !valid.has(id))
  ) {
    throw new ImportError("bad_setting");
  }
  await db.update(guestImports).set({ mapping: encodeSettings(settings) }).where(eq(guestImports.id, importId));
}

export async function existingGuestsForDedup(db: Tx, eventId: string): Promise<ExistingGuest[]> {
  // Sequential: this also runs inside the commit transaction (one connection).
  const rows = await db
    .select({ id: guests.id, name: guests.name, phone: guests.phone, email: guests.email, householdName: households.name, householdId: households.id })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(eq(guests.eventId, eventId));
  const invites = await db
    .select({ guestId: functionInvites.guestId, functionId: functionInvites.functionId })
    .from(functionInvites)
    .innerJoin(guests, eq(guests.id, functionInvites.guestId))
    .where(eq(guests.eventId, eventId));
  const answers = await db
    .select({ guestId: rsvps.guestId, functionId: rsvps.functionId, status: rsvps.status })
    .from(rsvps)
    .innerJoin(guests, eq(guests.id, rsvps.guestId))
    .where(eq(guests.eventId, eventId));
  const byId = new Map<string, ExistingGuest>(rows.map((g) => [g.id, { ...g, functionIds: [], rsvp: {} }]));
  for (const i of invites) byId.get(i.guestId)?.functionIds.push(i.functionId);
  for (const a of answers) {
    const g = byId.get(a.guestId);
    if (g) g.rsvp[a.functionId] = a.status;
  }
  return [...byId.values()];
}

export async function previewImport(db: Tx, eventId: string, importId: string, mapping?: StoredMapping | ImportSettings) {
  const imp = await getImport(db, eventId, importId);
  const fns = await listFunctions(db, eventId);
  const settings = decodeSettings(mapping ?? imp.mapping ?? {}, fns, imp.headers.length);
  const preview = buildPreview(imp.rows, settings, await existingGuestsForDedup(db, eventId), fns, imp.headers);
  return { imp, preview, settings, functions: fns };
}

export type ImportResult = { guests: number; households: number; skipped: number; updated: number; rsvps: number };

/**
 * Imports the valid, non-duplicate rows. Rows sharing a household value become
 * one household (merged into an existing household with the same name). Rows matching
 * an existing guest get the file's invitations and replies when "update existing" is on;
 * their name and contact details are never changed and no invitation is removed.
 */
export async function commitImport(db: Database, eventId: string, importId: string, actor: Actor, mapping: StoredMapping | ImportSettings): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(guestImports)
      .where(and(eq(guestImports.id, importId), eq(guestImports.eventId, eventId)))
      .for("update");
    if (!locked) throw new ImportError("not_found");
    if (locked.completedAt) throw new ImportError("already_done");

    const fns = await listFunctions(tx, eventId);
    const settings = decodeSettings(mapping, fns, locked.headers.length);
    const existing = await existingGuestsForDedup(tx, eventId);
    const preview = buildPreview(locked.rows, settings, existing, fns, locked.headers);
    const rows = preview.rows.filter((r) => r.action === "create");
    const updates = preview.rows.filter((r) => r.action === "update");

    // New invitations and replies change headcounts: freeze any due caterer lock first (RSV-07).
    const affected = new Set([...rows.flatMap((r) => r.functionIds), ...updates.flatMap((r) => r.changes.map((c) => c.functionId))]);
    await freezeDueLocks(tx, eventId, [...affected]);

    const existingHouseholds = await tx.select().from(households).where(eq(households.eventId, eventId));
    const householdIds = new Map(existingHouseholds.map((h) => [norm(h.name), h.id]));
    const householdNames = new Map(existingHouseholds.map((h) => [h.id, h.name]));
    // One rsvp.recorded audit entry per family whose replies the import sets (EVT-06).
    const fnName = new Map(fns.map((f) => [f.id, f.name]));
    const replyLog = new Map<string, { guest: string; function: string; from: RsvpStatus | null; to: RsvpStatus }[]>();
    const logReply = (householdId: string, guest: string, functionId: string, from: RsvpStatus | null, to: RsvpStatus) =>
      replyLog.set(householdId, [...(replyLog.get(householdId) ?? []), { guest, function: fnName.get(functionId) ?? "", from, to }]);
    const memberCounts = new Map<string, number>();
    const groups = new Map<string, PreviewRow[]>();
    for (const r of rows) groups.set(r.householdKey, [...(groups.get(r.householdKey) ?? []), r]);

    let createdHouseholds = 0;
    let createdGuests = 0;
    let recorded = 0;
    for (const [key, members] of groups) {
      let householdId = householdIds.get(key);
      let isNew = false;
      if (!householdId) {
        const first = members.find((m) => m.isHead) ?? members[0];
        const [h] = await tx
          .insert(households)
          .values({
            eventId,
            name: first.householdName,
            side: members.find((m) => m.side !== "both")?.side ?? "both",
            address: members.find((m) => m.address)?.address ?? null,
            city: members.find((m) => m.city)?.city ?? null,
            postalCode: members.find((m) => m.postalCode)?.postalCode ?? null,
            notes: members.find((m) => m.notes)?.notes ?? null,
          })
          .returning();
        householdId = h.id;
        householdIds.set(key, h.id);
        householdNames.set(h.id, h.name);
        isNew = true;
        createdHouseholds++;
      }
      if (!memberCounts.has(householdId)) {
        const existingMembers = isNew ? 0 : (await tx.select({ id: guests.id }).from(guests).where(eq(guests.householdId, householdId))).length;
        memberCounts.set(householdId, existingMembers);
      }
      const headIndex = Math.max(0, members.findIndex((m) => m.isHead));
      for (const [i, m] of members.entries()) {
        const order = memberCounts.get(householdId)!;
        const [g] = await tx
          .insert(guests)
          .values({
            eventId,
            householdId,
            name: m.name,
            isHead: isNew && i === headIndex,
            relation: m.relation,
            ageGroup: m.ageGroup,
            phone: m.phone,
            email: m.email,
            diet: m.diet,
            dietNotes: m.dietNotes,
            tags: m.tags,
            sortOrder: order,
          })
          .returning({ id: guests.id });
        memberCounts.set(householdId, order + 1);
        if (m.functionIds.length) {
          await tx
            .insert(functionInvites)
            .values(m.functionIds.map((functionId) => ({ functionId, guestId: g.id })))
            .onConflictDoNothing();
        }
        if (m.rsvps.length) {
          await tx.insert(rsvps).values(m.rsvps.map((a) => ({ functionId: a.functionId, guestId: g.id, status: a.status, recordedBy: actor.userId })));
          recorded += m.rsvps.length;
          for (const a of m.rsvps) logReply(householdId, m.name, a.functionId, null, a.status);
        }
        createdGuests++;
      }
    }

    // Guests already on the list: add invitations and set replies only.
    const existingById = new Map(existing.map((g) => [g.id, g]));
    for (const u of updates) {
      const guestId = u.existingGuestId!;
      const known = existingById.get(guestId)!;
      const newInvites = u.changes.filter((c) => c.newInvite).map((c) => ({ functionId: c.functionId, guestId }));
      if (newInvites.length) await tx.insert(functionInvites).values(newInvites).onConflictDoNothing();
      for (const c of u.changes) {
        if (!c.to || c.to === c.from) continue;
        await tx
          .insert(rsvps)
          .values({ functionId: c.functionId, guestId, status: c.to, recordedBy: actor.userId })
          .onConflictDoUpdate({ target: [rsvps.functionId, rsvps.guestId], set: { status: c.to, recordedBy: actor.userId, respondedAt: new Date() } });
        recorded++;
        if (known.householdId) {
          householdNames.set(known.householdId, known.householdName);
          logReply(known.householdId, known.name, c.functionId, c.from, c.to);
        }
      }
    }
    for (const [householdId, changes] of replyLog) {
      await audit(tx, {
        eventId,
        actor,
        action: "rsvp.recorded",
        entityType: "household",
        entityId: householdId,
        data: { name: householdNames.get(householdId) ?? "", changes: changes.length, source: "import", importId, functions: [...new Set(changes.map((c) => c.function))], replies: changes },
      });
    }

    const skipped = preview.rows.length - rows.length - updates.length;
    await tx.update(guestImports).set({ mapping: encodeSettings(settings), completedAt: new Date() }).where(eq(guestImports.id, importId));
    await audit(tx, {
      eventId,
      actor,
      action: "guests.imported",
      entityType: "import",
      entityId: importId,
      data: { filename: locked.filename, guests: createdGuests, households: createdHouseholds, skipped, updated: updates.length, rsvps: recorded },
    });
    return { guests: createdGuests, households: createdHouseholds, skipped, updated: updates.length, rsvps: recorded };
  });
}

// ---------------------------------------------------------------------------
// Export (GST-04)
// ---------------------------------------------------------------------------

export type ExportLabels = {
  headers: Record<Exclude<ImportField, "rsvp">, string>;
  sides: Record<Side, string>;
  ages: Record<AgeGroup, string>;
  diets: Record<Diet, string>;
  yes: string;
  summarySheet: string;
  guestsSheet: string;
  functionHeader: string;
  invitedHeader: string;
};

/**
 * Builds an .xlsx of guests. Column headers match the import synonyms, so an
 * exported file can be edited and imported into another event.
 */
export async function buildGuestWorkbook(
  rows: { guest: typeof guests.$inferSelect; household: typeof households.$inferSelect; functionIds: string[] }[],
  fns: { id: string; name: string }[],
  labels: ExportLabels,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "EventHub";
  const sheet = wb.addWorksheet(labels.guestsSheet, { views: [{ state: "frozen", ySplit: 1 }] });
  const order: Exclude<ImportField, "rsvp">[] = ["household", "side", "name", "isHead", "relation", "ageGroup", "phone", "email", "diet", "tags", "functions", "address", "city", "postalCode", "notes"];
  sheet.columns = order.map((f) => ({ header: labels.headers[f], key: f, width: f === "functions" || f === "address" ? 36 : f === "name" || f === "household" ? 24 : 16 }));
  sheet.getRow(1).font = { bold: true };
  const fnName = new Map(fns.map((f) => [f.id, f.name]));
  for (const { guest: g, household: h, functionIds } of rows) {
    sheet.addRow({
      household: h.name,
      side: labels.sides[h.side],
      name: g.name,
      isHead: g.isHead ? labels.yes : "",
      relation: g.relation ?? "",
      ageGroup: labels.ages[g.ageGroup],
      phone: g.phone ?? "",
      email: g.email ?? "",
      diet: g.diet ? (g.diet === "other" && g.dietNotes ? g.dietNotes : labels.diets[g.diet]) : "",
      tags: g.tags.join(", "),
      functions: functionIds.map((id) => fnName.get(id)).filter(Boolean).join(", "),
      address: h.address ?? "",
      city: h.city ?? "",
      postalCode: h.postalCode ?? "",
      notes: h.notes ?? "",
    });
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: order.length } };

  const summary = wb.addWorksheet(labels.summarySheet);
  summary.columns = [
    { header: labels.functionHeader, key: "fn", width: 30 },
    { header: labels.invitedHeader, key: "n", width: 12 },
  ];
  summary.getRow(1).font = { bold: true };
  for (const fn of fns) summary.addRow({ fn: fn.name, n: rows.filter((r) => r.functionIds.includes(fn.id)).length });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
