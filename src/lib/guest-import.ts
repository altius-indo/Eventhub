import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import type { Database, Tx } from "@/db";
import { functionInvites, guestImports, guests, households, type AgeGroup, type Diet, type Side } from "@/db/schema";
import { audit, type Actor } from "./audit";
import { listFunctions } from "./functions";
import { normalizeEmail, normalizePhone, normalizeTags } from "./guests";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export class ImportError extends Error {
  constructor(public code: "unsupported" | "empty" | "too_many_rows" | "too_large" | "not_found" | "no_name_column" | "already_done") {
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
};

const norm = (s: string) => s.toLowerCase().replace(/[_*:]/g, " ").replace(/\s+/g, " ").trim();

/** Guesses which column holds which field from the header names. */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  for (const field of importFields) {
    const options = synonyms[field];
    let idx = headers.findIndex((h, i) => !used.has(i) && options.includes(norm(h)));
    if (idx < 0) idx = headers.findIndex((h, i) => !used.has(i) && options.some((o) => o.length > 3 && norm(h).includes(o)));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
    }
  }
  return mapping;
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

// ---------------------------------------------------------------------------
// Preview (validation + duplicates)
// ---------------------------------------------------------------------------

export type RowIssue =
  | { kind: "error"; code: "missingName" }
  | { kind: "warning"; code: "phoneInvalid" | "emailInvalid" | "sideUnknown" | "ageUnknown"; value: string }
  | { kind: "warning"; code: "functionUnknown"; value: string }
  | { kind: "skip"; code: "duplicateInFile"; row: number }
  | { kind: "skip"; code: "alreadyInList"; name: string };

export type PreviewRow = {
  row: number; // 1-based spreadsheet row number (header is row 1)
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
  functionIds: string[];
  issues: RowIssue[];
};

export type ImportPreview = {
  rows: PreviewRow[];
  importable: number;
  skipped: number;
  errors: number;
  warnings: number;
  households: number;
};

type ExistingGuest = { name: string; phone: string | null; email: string | null; householdName: string };

export function buildPreview(
  rows: string[][],
  mapping: ColumnMapping,
  existing: ExistingGuest[],
  fns: { id: string; name: string }[],
): ImportPreview {
  if (mapping.name === undefined) throw new ImportError("no_name_column");
  const get = (r: string[], f: ImportField) => (mapping[f] === undefined ? "" : (r[mapping[f]!] ?? "").trim());
  const fnByName = new Map(fns.map((f) => [norm(f.name), f.id]));

  const existingPhones = new Map(existing.filter((g) => g.phone).map((g) => [g.phone!, g.name]));
  const existingEmails = new Map(existing.filter((g) => g.email).map((g) => [g.email!, g.name]));
  const existingNames = new Set(existing.map((g) => `${norm(g.householdName)}|${norm(g.name)}`));
  const seenPhones = new Map<string, number>();
  const seenEmails = new Map<string, number>();
  const seenNames = new Map<string, number>();

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

    const functionIds: string[] = [];
    for (const fnName of get(r, "functions").split(/[,;/]/).map((s) => s.trim()).filter(Boolean)) {
      const id = fnByName.get(norm(fnName));
      if (id) functionIds.push(id);
      else issues.push({ kind: "warning", code: "functionUnknown", value: fnName });
    }

    const householdName = get(r, "household") || name;
    const { diet, notes: dietNotes } = parseDiet(get(r, "diet"));

    // Duplicates: an earlier row in the file, or someone already on the guest list
    const validPhone = phone && phone !== "invalid" ? phone : null;
    const validEmail = email && email !== "invalid" ? email : null;
    const nameKey = `${norm(householdName)}|${norm(name)}`;
    if (name) {
      const firstRow =
        (validPhone && seenPhones.get(validPhone)) || (validEmail && seenEmails.get(validEmail)) || seenNames.get(nameKey);
      if (firstRow) issues.push({ kind: "skip", code: "duplicateInFile", row: firstRow });
      else {
        const match =
          (validPhone && existingPhones.get(validPhone)) ||
          (validEmail && existingEmails.get(validEmail)) ||
          (existingNames.has(nameKey) ? name : undefined);
        if (match) issues.push({ kind: "skip", code: "alreadyInList", name: match });
      }
      if (validPhone && !seenPhones.has(validPhone)) seenPhones.set(validPhone, rowNo);
      if (validEmail && !seenEmails.has(validEmail)) seenEmails.set(validEmail, rowNo);
      if (!seenNames.has(nameKey)) seenNames.set(nameKey, rowNo);
    }

    return {
      row: rowNo,
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
      issues,
    };
  });

  const importable = out.filter((r) => !r.issues.some((i) => i.kind === "error" || i.kind === "skip"));
  return {
    rows: out,
    importable: importable.length,
    skipped: out.filter((r) => r.issues.some((i) => i.kind === "skip")).length,
    errors: out.filter((r) => r.issues.some((i) => i.kind === "error")).length,
    warnings: out.filter((r) => r.issues.some((i) => i.kind === "warning")).length,
    households: new Set(importable.map((r) => r.householdKey)).size,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function createImport(db: Tx, eventId: string, userId: string, filename: string, parsed: { headers: string[]; rows: string[][] }) {
  const [row] = await db
    .insert(guestImports)
    .values({ eventId, createdBy: userId, filename: filename.slice(0, 200), headers: parsed.headers, rows: parsed.rows, mapping: guessMapping(parsed.headers) })
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

export async function existingGuestsForDedup(db: Tx, eventId: string): Promise<ExistingGuest[]> {
  return db
    .select({ name: guests.name, phone: guests.phone, email: guests.email, householdName: households.name })
    .from(guests)
    .innerJoin(households, eq(households.id, guests.householdId))
    .where(eq(guests.eventId, eventId));
}

export async function previewImport(db: Tx, eventId: string, importId: string, mapping?: ColumnMapping) {
  const imp = await getImport(db, eventId, importId);
  const fns = await listFunctions(db, eventId);
  const preview = buildPreview(imp.rows, mapping ?? imp.mapping ?? {}, await existingGuestsForDedup(db, eventId), fns);
  return { imp, preview };
}

/**
 * Imports the valid, non-duplicate rows. Rows sharing a household value become
 * one household (merged into an existing household with the same name).
 */
export async function commitImport(db: Database, eventId: string, importId: string, actor: Actor, mapping: ColumnMapping) {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(guestImports)
      .where(and(eq(guestImports.id, importId), eq(guestImports.eventId, eventId)))
      .for("update");
    if (!locked) throw new ImportError("not_found");
    if (locked.completedAt) throw new ImportError("already_done");

    const fns = await listFunctions(tx, eventId);
    const preview = buildPreview(locked.rows, mapping, await existingGuestsForDedup(tx, eventId), fns);
    const rows = preview.rows.filter((r) => !r.issues.some((i) => i.kind === "error" || i.kind === "skip"));

    const existingHouseholds = await tx.select().from(households).where(eq(households.eventId, eventId));
    const householdIds = new Map(existingHouseholds.map((h) => [norm(h.name), h.id]));
    const memberCounts = new Map<string, number>();
    const groups = new Map<string, PreviewRow[]>();
    for (const r of rows) groups.set(r.householdKey, [...(groups.get(r.householdKey) ?? []), r]);

    let createdHouseholds = 0;
    let createdGuests = 0;
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
        createdGuests++;
      }
    }

    await tx.update(guestImports).set({ mapping, completedAt: new Date() }).where(eq(guestImports.id, importId));
    await audit(tx, {
      eventId,
      actor,
      action: "guests.imported",
      entityType: "import",
      entityId: importId,
      data: { filename: locked.filename, guests: createdGuests, households: createdHouseholds, skipped: preview.rows.length - rows.length },
    });
    return { guests: createdGuests, households: createdHouseholds, skipped: preview.rows.length - rows.length };
  });
}

// ---------------------------------------------------------------------------
// Export (GST-04)
// ---------------------------------------------------------------------------

export type ExportLabels = {
  headers: Record<ImportField, string>;
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
  const order: ImportField[] = ["household", "side", "name", "isHead", "relation", "ageGroup", "phone", "email", "diet", "tags", "functions", "address", "city", "postalCode", "notes"];
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
