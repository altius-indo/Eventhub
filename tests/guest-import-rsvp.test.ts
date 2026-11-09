import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, functionInvites, guests, rsvps } from "@/db/schema";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import {
  buildPreview,
  commitImport,
  createImport,
  decodeSettings,
  encodeSettings,
  getImport,
  guessFunctionColumns,
  guessMapping,
  guessSettings,
  ImportError,
  parseRsvpCell,
  parseSpreadsheet,
  previewImport,
  saveImportSettings,
  type ImportSettings,
} from "@/lib/guest-import";
import { createHousehold, guestSchema } from "@/lib/guests";
import { headcounts, setRsvp } from "@/lib/rsvp";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const blank = { date: null, startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("RSVP cell values", () => {
  it("understands every English and Hindi variant", () => {
    const cases: [string, ReturnType<typeof parseRsvpCell>][] = [
      ["Attending", { status: "attending" }],
      ["yes", { status: "attending" }],
      ["Y", { status: "attending" }],
      ["Coming", { status: "attending" }],
      ["हाँ", { status: "attending" }],
      ["हां", { status: "attending" }],
      ["आएंगे", { status: "attending" }],
      ["Maybe", { status: "maybe" }],
      ["शायद", { status: "maybe" }],
      ["No", { status: "declined" }],
      ["not attending", { status: "declined" }],
      ["Not  Attending", { status: "declined" }],
      ["Declined", { status: "declined" }],
      ["नहीं", { status: "declined" }],
      ["नहीं आ पाएँगे", { status: "declined" }],
      ["Invited", { status: null }],
      ["x", { status: null }],
      ["X", { status: null }],
      ["✓", { status: null }],
      ["✔", { status: null }],
      ["✔️", { status: null }],
      ["1", { status: null }],
      ["TRUE", { status: null }],
      ["yes.", { status: "attending" }],
      ["", null],
      ["   ", null],
      ["perhaps later", "unknown"],
      ["2", "unknown"],
    ];
    for (const [raw, expected] of cases) expect([raw, parseRsvpCell(raw)]).toEqual([raw, expected]);
  });

  it("matches headers to functions (case, spaces, Hindi names, an RSVP suffix) and leaves them out of the field guess", () => {
    const fns = [
      { id: "f1", name: "Sangeet" },
      { id: "f2", name: "Haldi Ceremony" },
      { id: "f3", name: "हल्दी" },
      { id: "f4", name: "Reception" },
    ];
    const headers = ["Name", "SANGEET", "haldi  ceremony", "हल्दी", "Reception RSVP", "Status", "Travel status"];
    expect(guessFunctionColumns(headers, fns)).toEqual({ f1: 1, f2: 2, f3: 3, f4: 4 });
    const s = guessSettings(headers, fns);
    expect(s.mapping).toEqual({ name: 0, rsvp: 5 });
    // "Travel status" isn't an RSVP column; a lone "Reply" header is.
    expect(guessMapping(["Name", "Travel status"])).toEqual({ name: 0 });
    expect(guessMapping(["Name", "Reply"])).toEqual({ name: 0, rsvp: 1 });
    expect(guessMapping(["नाम", "जवाब"])).toEqual({ name: 0, rsvp: 1 });
  });

  it("round-trips settings and drops other events' function ids and missing columns", () => {
    const s: ImportSettings = { mapping: { name: 0, rsvp: 2 }, functionColumns: { f1: 1, zz: 1 }, inviteAll: ["f1", "zz"], updateExisting: false };
    expect(decodeSettings(encodeSettings(s), [{ id: "f1" }], 3)).toEqual({ mapping: { name: 0, rsvp: 2 }, functionColumns: { f1: 1 }, inviteAll: ["f1"], updateExisting: false });
    expect(decodeSettings({ name: 0, "fn:f1": 7 }, [{ id: "f1" }], 3)).toEqual({ mapping: { name: 0 }, functionColumns: {}, inviteAll: [], updateExisting: null });
  });
});

describe("preview with functions and RSVPs", () => {
  const fns = [
    { id: "m", name: "Mehendi" },
    { id: "s", name: "Sangeet" },
    { id: "w", name: "Wedding" },
  ];
  const headers = ["Name", "Functions", "Sangeet", "RSVP"];

  it("per-function columns invite and reply; the RSVP column fills the rest; per-function wins", () => {
    const settings: ImportSettings = { mapping: { name: 0, functions: 1, rsvp: 3 }, functionColumns: { s: 2 }, inviteAll: ["w"], updateExisting: null };
    const p = buildPreview(
      [
        ["Asha", "Mehendi", "No", "Yes"], // Sangeet: own column says no; Mehendi + Wedding get the RSVP column's yes
        ["Ravi", "", "x", "maybe"], // invited to Sangeet without a reply there → takes maybe
        ["Kiran", "", "", ""], // only the invite-everyone function
        ["Dev", "", "perhaps", ""], // unknown value: warning, no Sangeet invite
        ["Mira", "", "", "kal batayenge"], // unknown RSVP value
      ],
      settings,
      [],
      fns,
      headers,
    );
    const [asha, ravi, kiran, dev, mira] = p.rows;
    expect(asha.functionIds).toEqual(["m", "s", "w"]);
    expect(asha.rsvps).toEqual([
      { functionId: "m", status: "attending" },
      { functionId: "s", status: "declined" },
      { functionId: "w", status: "attending" },
    ]);
    expect(ravi.rsvps).toEqual([
      { functionId: "s", status: "maybe" },
      { functionId: "w", status: "maybe" },
    ]);
    expect(kiran).toMatchObject({ functionIds: ["w"], rsvps: [], action: "create" });
    expect(dev.functionIds).toEqual(["w"]);
    expect(dev.issues).toEqual([{ kind: "warning", code: "rsvpUnknown", value: "perhaps", column: "Sangeet" }]);
    expect(mira.issues).toEqual([{ kind: "warning", code: "rsvpUnknown", value: "kal batayenge", column: "RSVP" }]);
    expect(p).toMatchObject({ importable: 5, rsvps: 5, warnings: 2, updateExisting: true });
  });

  it("warns when an RSVP is given but there's nothing to apply it to", () => {
    const p = buildPreview([["Asha", "", "", "Yes"]], { mapping: { name: 0, rsvp: 3 }, functionColumns: {}, inviteAll: [], updateExisting: null }, [], fns, headers);
    expect(p.rows[0].issues).toEqual([{ kind: "warning", code: "rsvpNoFunction", value: "Yes" }]);
  });

  it("ignores function ids from other events in stored settings", () => {
    const p = buildPreview([["Asha"]], { name: 0, "all:not-ours": 1 }, [], fns);
    expect(p.rows[0].functionIds).toEqual([]);
  });

  it("existing guests: update with the changes, or skip when off or nothing changes", () => {
    const existing = [{ id: "g1", name: "Asha", phone: null, email: null, householdName: "Asha", functionIds: ["s"], rsvp: { s: "maybe" as const } }];
    const rows = [["Asha", "", "Yes", ""]];
    const on = buildPreview(rows, { mapping: { name: 0 }, functionColumns: { s: 2 }, inviteAll: ["w"], updateExisting: null }, existing, fns, headers);
    expect(on.rows[0]).toMatchObject({
      action: "update",
      existingGuestId: "g1",
      changes: [
        { functionId: "s", newInvite: false, from: "maybe", to: "attending" },
        { functionId: "w", newInvite: true, from: null, to: null },
      ],
    });
    expect(on.rows[0].issues).toEqual([{ kind: "info", code: "updateExisting", name: "Asha" }]);
    expect(on).toMatchObject({ importable: 0, updates: 1, rsvps: 1, skipped: 0 });

    const off = buildPreview(rows, { mapping: { name: 0 }, functionColumns: { s: 2 }, inviteAll: [], updateExisting: false }, existing, fns, headers);
    expect(off.rows[0]).toMatchObject({ action: "skip", issues: [{ kind: "skip", code: "alreadyInList", name: "Asha" }] });

    const same = buildPreview([["Asha", "", "Maybe", ""]], { mapping: { name: 0 }, functionColumns: { s: 2 }, inviteAll: [], updateExisting: true }, existing, fns, headers);
    expect(same.rows[0].action).toBe("skip");

    // No invite/RSVP data in the file: the default is off.
    expect(buildPreview(rows, { mapping: { name: 0 }, functionColumns: {}, inviteAll: [], updateExisting: null }, existing, fns).updateExisting).toBe(false);
  });
});

describe("commit with functions and RSVPs", () => {
  async function setup() {
    const host = await makeUser("host@example.com", "Asha");
    const actor = actorOf(host);
    const event = await createEvent(db(), actor, { name: "Wedding" });
    const mehendi = await createFunction(db(), event.id, actor, { name: "Mehendi", ...blank });
    const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", ...blank });
    const wedding = await createFunction(db(), event.id, actor, { name: "Wedding", ...blank });
    const neha = await createHousehold(db(), event.id, actor, {
      household: { name: "Gupta", side: "bride", address: null, city: null, postalCode: null, notes: null },
      members: [guestSchema.parse({ name: "Neha Gupta", phone: "9988776655", email: "neha@example.com" })],
    });
    const nehaId = neha.members[0].id;
    await db().insert(functionInvites).values({ functionId: mehendi.id, guestId: nehaId });
    await setRsvp(db(), event.id, actor, { guestId: nehaId, functionId: mehendi.id, status: "declined" });
    return { host, actor, event, mehendi, sangeet, wedding, nehaId };
  }

  it("creates guests with invites and replies and updates existing guests without touching contact data", async () => {
    const s = await setup();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Guests");
    ws.addRow(["Family", "Name", "Mobile", "Email", "Sangeet", "RSVP"]);
    ws.addRow(["Sharma", "Rajesh Sharma", "98765 43210", "", "Yes", ""]);
    ws.addRow(["Sharma", "Sunita Sharma", "", "", "Maybe", ""]);
    ws.addRow(["Verma", "Anil Verma", "", "", "No", ""]);
    ws.addRow(["Khan", "Imran Khan", "", "", "Invited", ""]);
    // Existing guest, matched by phone; the file has a different name and email.
    ws.addRow(["Gupta", "Neha G", "+91 99887 76655", "other@example.com", "Yes", ""]);
    const parsed = await parseSpreadsheet((await wb.xlsx.writeBuffer()) as ArrayBuffer, "guests.xlsx");
    const imp = await createImport(db(), s.event.id, s.actor.userId, "guests.xlsx", parsed);
    // Sangeet is auto-mapped as a function column.
    const { settings, preview } = await previewImport(db(), s.event.id, imp.id);
    expect(settings.functionColumns).toEqual({ [s.sangeet.id]: 4 });
    expect(settings.mapping).toMatchObject({ household: 0, name: 1, phone: 2, email: 3, rsvp: 5 });
    expect(preview.rows.map((r) => r.action)).toEqual(["create", "create", "create", "create", "update"]);
    expect(preview).toMatchObject({ importable: 4, updates: 1, rsvps: 4, updateExisting: true });

    // Also invite everyone to the Wedding (validated against this event).
    await saveImportSettings(db(), s.event.id, imp.id, { ...settings, inviteAll: [s.wedding.id] });
    const stored = (await getImport(db(), s.event.id, imp.id)).mapping!;
    const result = await commitImport(db(), s.event.id, imp.id, s.actor, stored);
    expect(result).toEqual({ guests: 4, households: 3, skipped: 0, updated: 1, rsvps: 4 });

    const counts = await headcounts(db(), s.event.id);
    expect(counts.get(s.sangeet.id)).toMatchObject({ invited: 5, attending: 2, maybe: 1, declined: 1, pending: 1 });
    expect(counts.get(s.wedding.id)).toMatchObject({ invited: 5, pending: 5 });
    // Neha's Mehendi invite and reply are kept; her name and contact details are unchanged.
    expect(counts.get(s.mehendi.id)).toMatchObject({ invited: 1, declined: 1 });
    const [neha] = await db().select().from(guests).where(eq(guests.id, s.nehaId));
    expect(neha).toMatchObject({ name: "Neha Gupta", phone: "+919988776655", email: "neha@example.com" });
    const nehaAnswers = await db().select().from(rsvps).where(eq(rsvps.guestId, s.nehaId));
    expect(nehaAnswers.map((a) => [a.functionId, a.status, a.recordedBy]).sort()).toEqual(
      [
        [s.mehendi.id, "declined", s.host.id],
        [s.sangeet.id, "attending", s.host.id],
      ].sort(),
    );

    // One summary audit entry for the import, with counts.
    const entries = await db().select().from(auditLogs).where(and(eq(auditLogs.eventId, s.event.id), eq(auditLogs.action, "guests.imported")));
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toMatchObject({ guests: 4, updated: 1, rsvps: 4 });
  });

  it("can leave existing guests alone", async () => {
    const s = await setup();
    const parsed = await parseSpreadsheet(enc("Name,Mobile,Sangeet\nNeha,9988776655,Yes\nNew Person,,Yes"), "g.csv");
    const imp = await createImport(db(), s.event.id, s.actor.userId, "g.csv", parsed);
    const { settings } = await previewImport(db(), s.event.id, imp.id);
    const result = await commitImport(db(), s.event.id, imp.id, s.actor, { ...settings, updateExisting: false });
    expect(result).toEqual({ guests: 1, households: 1, skipped: 1, updated: 0, rsvps: 1 });
    expect(await db().select().from(functionInvites).where(eq(functionInvites.guestId, s.nehaId))).toHaveLength(1);
  });

  it("rejects settings that name another event's function or a missing column", async () => {
    const s = await setup();
    const other = await createEvent(db(), s.actor, { name: "Other" });
    const theirs = await createFunction(db(), other.id, s.actor, { name: "Sangeet", ...blank });
    const parsed = await parseSpreadsheet(enc("Name,Sangeet\nAsha,Yes"), "g.csv");
    const imp = await createImport(db(), s.event.id, s.actor.userId, "g.csv", parsed);
    const base: ImportSettings = { mapping: { name: 0 }, functionColumns: {}, inviteAll: [], updateExisting: null };
    await expect(saveImportSettings(db(), s.event.id, imp.id, { ...base, inviteAll: [theirs.id] })).rejects.toMatchObject({ code: "bad_setting" });
    await expect(saveImportSettings(db(), s.event.id, imp.id, { ...base, functionColumns: { [theirs.id]: 1 } })).rejects.toBeInstanceOf(ImportError);
    await expect(saveImportSettings(db(), s.event.id, imp.id, { ...base, mapping: { name: 9 } })).rejects.toMatchObject({ code: "bad_setting" });
    // Even if such ids reach commit directly, they're dropped.
    const res = await commitImport(db(), s.event.id, imp.id, s.actor, { ...base, inviteAll: [theirs.id], functionColumns: { [theirs.id]: 1 } });
    expect(res).toMatchObject({ guests: 1, rsvps: 0 });
    expect(await db().select().from(functionInvites).where(eq(functionInvites.functionId, theirs.id))).toHaveLength(0);
  });
});
