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
  detectColumnMode,
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
    const s: ImportSettings = {
      mapping: { name: 0, rsvp: 2 },
      functionColumns: { f1: 1, zz: 1 },
      functionColumnModes: { f1: "invites", zz: "replies" },
      inviteAll: ["f1", "zz"],
      updateExisting: false,
    };
    expect(decodeSettings(encodeSettings(s), [{ id: "f1" }], 3)).toEqual({
      mapping: { name: 0, rsvp: 2 },
      functionColumns: { f1: 1 },
      functionColumnModes: { f1: "invites" },
      inviteAll: ["f1"],
      updateExisting: false,
    });
    expect(decodeSettings({ name: 0, "fn:f1": 7, "fnmode:f1": 5 }, [{ id: "f1" }], 3)).toEqual({
      mapping: { name: 0 },
      functionColumns: {},
      functionColumnModes: {},
      inviteAll: [],
      updateExisting: null,
    });
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
    const settings: ImportSettings = {
      mapping: { name: 0, functions: 1, rsvp: 3 },
      functionColumns: { s: 2 },
      functionColumnModes: { s: "replies" },
      inviteAll: ["w"],
      updateExisting: null,
    };
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
    expect(p).toMatchObject({ importable: 5, rsvps: 5, warnings: 2, updateExisting: true, columnModes: { s: "replies" } });
  });

  it("detects whether a function column holds replies or invitations", () => {
    expect(detectColumnMode("Sangeet", ["Yes", "No", "", "x", "✓"])).toBe("invites");
    expect(detectColumnMode("Sangeet", ["Yes", "Maybe"])).toBe("replies");
    expect(detectColumnMode("Sangeet", ["", "Not attending"])).toBe("replies");
    expect(detectColumnMode("Sangeet", ["declined"])).toBe("replies");
    expect(detectColumnMode("Sangeet", ["attending"])).toBe("replies");
    expect(detectColumnMode("Sangeet", ["हाँ", "शायद"])).toBe("replies");
    expect(detectColumnMode("Sangeet", ["हाँ", "नहीं"])).toBe("invites");
    expect(detectColumnMode("Sangeet RSVP", ["Yes", "No"])).toBe("replies");
    expect(detectColumnMode("संगीत जवाब", ["हाँ"])).toBe("replies");
    expect(detectColumnMode("Reply - Haldi", [])).toBe("replies");
  });

  it("invitation columns: Yes/x/✓ invite, No or blank does nothing, never a reply; replies can be chosen", () => {
    const rows = [["Asha", "", "Yes", ""], ["Ravi", "", "No", ""], ["Kiran", "", "x", ""], ["Dev", "", "", ""], ["Mira", "", "✓", ""], ["Om", "", "huh", ""]];
    const auto = buildPreview(rows, { mapping: { name: 0 }, functionColumns: { s: 2 }, inviteAll: [], updateExisting: null }, [], fns, headers);
    expect(auto.columnModes).toEqual({ s: "invites" });
    expect(auto.rows.map((r) => r.functionIds)).toEqual([["s"], [], ["s"], [], ["s"], []]);
    expect(auto.rows.every((r) => r.rsvps.length === 0)).toBe(true);
    expect(auto.rows[5].issues).toEqual([{ kind: "warning", code: "rsvpUnknown", value: "huh", column: "Sangeet" }]);
    expect(auto.rsvps).toBe(0);

    // The Host says the same column means replies: No now invites and declines.
    const replies = buildPreview(rows, { mapping: { name: 0 }, functionColumns: { s: 2 }, functionColumnModes: { s: "replies" }, inviteAll: [], updateExisting: null }, [], fns, headers);
    expect(replies.columnModes).toEqual({ s: "replies" });
    expect(replies.rows[0].rsvps).toEqual([{ functionId: "s", status: "attending" }]);
    expect(replies.rows[1]).toMatchObject({ functionIds: ["s"], rsvps: [{ functionId: "s", status: "declined" }] });
    expect(replies.rows[2]).toMatchObject({ functionIds: ["s"], rsvps: [] });

    // And a column of replies can be read as invitations only.
    const invites = buildPreview([["Asha", "", "Maybe", ""], ["Ravi", "", "No", ""]], { mapping: { name: 0 }, functionColumns: { s: 2 }, functionColumnModes: { s: "invites" }, inviteAll: [], updateExisting: null }, [], fns, headers);
    expect(invites.rows.map((r) => [r.functionIds, r.rsvps])).toEqual([[["s"], []], [[], []]]);
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
    const on = buildPreview(rows, { mapping: { name: 0 }, functionColumns: { s: 2 }, functionColumnModes: { s: "replies" }, inviteAll: ["w"], updateExisting: null }, existing, fns, headers);
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

  it("only updates the same person: a shared family phone or email never moves a reply to someone else", () => {
    const phone = "+919876543210";
    const rajesh = { id: "r", name: "Rajesh Sharma", phone, email: "family@example.com", householdName: "Sharma", functionIds: ["s"], rsvp: { s: "attending" as const } };
    const settings: ImportSettings = { mapping: { name: 1, household: 0, phone: 2, email: 3 }, functionColumns: { s: 4 }, functionColumnModes: { s: "replies" }, inviteAll: [], updateExisting: true };
    const hdr = ["Family", "Name", "Mobile", "Email", "Sangeet"];

    // Sunita shares Rajesh's mobile and email: she's a possible duplicate, not Rajesh.
    const sunita = buildPreview([["Sharma family", "Sunita Sharma", "98765 43210", "family@example.com", "No"]], settings, [rajesh], fns, hdr);
    expect(sunita.rows[0]).toMatchObject({ action: "skip", existingGuestId: null, changes: [], issues: [{ kind: "skip", code: "alreadyInList", name: "Rajesh Sharma" }] });

    // Rajesh himself, in a differently spelled family, matched by phone + agreeing name.
    const him = buildPreview([["Sharmas", "  rajesh   SHARMA ", "98765 43210", "", "No"]], settings, [rajesh], fns, hdr);
    expect(him.rows[0]).toMatchObject({ action: "update", existingGuestId: "r", changes: [{ functionId: "s", from: "attending", to: "declined" }] });

    // Two guests on the list share the phone: a phone match alone is ambiguous → skip.
    const namesake = { ...rajesh, id: "su", name: "Rajesh Sharma", householdName: "Sharma (Delhi)", rsvp: {} };
    const ambiguous = buildPreview([["Sharmas", "Rajesh Sharma", "98765 43210", "", "No"]], settings, [rajesh, namesake], fns, hdr);
    expect(ambiguous.rows[0]).toMatchObject({ action: "skip", existingGuestId: null });
    // …but the exact family + name still identifies one person.
    const exact = buildPreview([["Sharma", "Rajesh Sharma", "98765 43210", "", "Maybe"]], settings, [rajesh, namesake], fns, hdr);
    expect(exact.rows[0]).toMatchObject({ action: "update", existingGuestId: "r" });
  });

  it("the RSVP column also covers functions a matched guest is already invited to", () => {
    const existing = [{ id: "g1", name: "Asha", phone: null, email: null, householdName: "Asha", functionIds: ["m", "w"], rsvp: { w: "declined" as const } }];
    const p = buildPreview([["Asha", "", "", "Yes"]], { mapping: { name: 0, rsvp: 3 }, functionColumns: {}, inviteAll: [], updateExisting: null }, existing, fns, headers);
    expect(p.rows[0]).toMatchObject({
      action: "update",
      functionIds: [],
      changes: [
        { functionId: "m", newInvite: false, from: null, to: "attending" },
        { functionId: "w", newInvite: false, from: "declined", to: "attending" },
      ],
      issues: [{ kind: "info", code: "updateExisting", name: "Asha" }],
    });
  });

  it("a second row for the same existing guest is a duplicate of the first", () => {
    const existing = [{ id: "g1", name: "Asha Rao", phone: "+919000000001", email: null, householdName: "Rao", functionIds: [], rsvp: {} }];
    const p = buildPreview(
      [
        ["Asha Rao", "Mehendi", "", ""],
        ["asha rao", "Wedding", "", ""],
      ],
      { mapping: { name: 0, functions: 1, household: 2 }, functionColumns: {}, inviteAll: [], updateExisting: true },
      existing.map((g) => ({ ...g, householdName: "Asha Rao" })),
      fns,
      headers,
    );
    expect(p.rows.map((r) => r.action)).toEqual(["update", "skip"]);
    expect(p.rows[1].issues).toEqual([{ kind: "skip", code: "duplicateInFile", row: 2 }]);

    // Same person reached once by name and once by phone (different family spelling).
    const q = buildPreview(
      [
        ["Rao", "Asha Rao", "", "Yes"],
        ["Rao family", "Asha Rao", "90000 00001", "Yes"],
      ],
      { mapping: { household: 0, name: 1, phone: 2, rsvp: 3 }, functionColumns: {}, inviteAll: ["m"], updateExisting: true },
      existing,
      fns,
      ["Family", "Name", "Mobile", "RSVP"],
    );
    expect(q.rows.map((r) => r.action)).toEqual(["update", "skip"]);
    expect(q.rows[1].issues).toEqual([{ kind: "skip", code: "duplicateInFile", row: 2 }]);
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
    // Existing guest, matched by phone and the same name (spelled differently); the file has another email.
    ws.addRow(["Gupta family", "neha  GUPTA", "+91 99887 76655", "other@example.com", "Yes", ""]);
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

    // Plus one rsvp.recorded entry per family whose replies changed (EVT-06), without contact data.
    const recorded = (await db().select().from(auditLogs).where(and(eq(auditLogs.eventId, s.event.id), eq(auditLogs.action, "rsvp.recorded")))).filter(
      (e) => (e.data as { source?: string }).source === "import",
    );
    const byFamily = Object.fromEntries(recorded.map((e) => [(e.data as { name: string }).name, e.data as { changes: number; functions: string[]; replies: unknown[] }]));
    expect(Object.keys(byFamily).sort()).toEqual(["Gupta", "Sharma", "Verma"]);
    expect(byFamily.Sharma).toMatchObject({
      changes: 2,
      functions: ["Sangeet"],
      replies: [
        { guest: "Rajesh Sharma", function: "Sangeet", from: null, to: "attending" },
        { guest: "Sunita Sharma", function: "Sangeet", from: null, to: "maybe" },
      ],
    });
    expect(byFamily.Gupta.replies).toEqual([{ guest: "Neha Gupta", function: "Sangeet", from: null, to: "attending" }]);
    expect(recorded.every((e) => e.actorUserId === s.host.id && e.entityType === "household")).toBe(true);
    expect(JSON.stringify(recorded.map((e) => e.data))).not.toMatch(/98765|99887|example\.com/);
  });

  it("a family member sharing a listed guest's mobile is never treated as that guest", async () => {
    const s = await setup();
    const sharma = await createHousehold(db(), s.event.id, s.actor, {
      household: { name: "Sharma", side: "bride", address: null, city: null, postalCode: null, notes: null },
      members: [guestSchema.parse({ name: "Rajesh Sharma", phone: "9876543210" })],
    });
    const rajeshId = sharma.members[0].id;
    await db().insert(functionInvites).values({ functionId: s.sangeet.id, guestId: rajeshId });
    await setRsvp(db(), s.event.id, s.actor, { guestId: rajeshId, functionId: s.sangeet.id, status: "attending" });

    const parsed = await parseSpreadsheet(enc("Family,Name,Mobile,Sangeet\nSharma family,Sunita Sharma,98765 43210,No\nSharma family,Asha Sharma,,Maybe"), "g.csv");
    const imp = await createImport(db(), s.event.id, s.actor.userId, "g.csv", parsed);
    const { preview } = await previewImport(db(), s.event.id, imp.id);
    expect(preview.columnModes).toEqual({ [s.sangeet.id]: "replies" });
    expect(preview.rows[0]).toMatchObject({ action: "skip", issues: [{ kind: "skip", code: "alreadyInList", name: "Rajesh Sharma" }] });
    const result = await commitImport(db(), s.event.id, imp.id, s.actor, (await getImport(db(), s.event.id, imp.id)).mapping!);
    expect(result).toMatchObject({ guests: 1, updated: 0, skipped: 1 });
    // Rajesh's reply is untouched.
    expect((await db().select().from(rsvps).where(eq(rsvps.guestId, rajeshId))).map((a) => a.status)).toEqual(["attending"]);
  });

  it("can leave existing guests alone", async () => {
    const s = await setup();
    const parsed = await parseSpreadsheet(enc("Name,Mobile,Sangeet\nNeha,9988776655,Yes\nNew Person,,Yes"), "g.csv");
    const imp = await createImport(db(), s.event.id, s.actor.userId, "g.csv", parsed);
    const { settings } = await previewImport(db(), s.event.id, imp.id);
    const result = await commitImport(db(), s.event.id, imp.id, s.actor, { ...settings, updateExisting: false });
    // The Sangeet column only has Yes, so it is read as invitations: no replies.
    expect(result).toEqual({ guests: 1, households: 1, skipped: 1, updated: 0, rsvps: 0 });
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
