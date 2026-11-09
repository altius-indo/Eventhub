import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { createEvent } from "@/lib/events";
import { createFunction } from "@/lib/functions";
import {
  buildGuestWorkbook,
  buildPreview,
  commitImport,
  createImport,
  guessMapping,
  ImportError,
  parseAgeGroup,
  parseCsv,
  parseDiet,
  parseSide,
  parseSpreadsheet,
  previewImport,
} from "@/lib/guest-import";
import { createHousehold, guestSchema, listAllGuests, listGuests } from "@/lib/guests";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const csv = `Family,Name,Side,Mobile,Email,Age,Food,Tags,Functions,Head
Sharma family,Rajesh Sharma,Ladkiwale,98765 43210,rajesh@example.com,45,Veg,"VIP, elders","Mehendi, Sangeet",yes
Sharma family,Sunita Sharma,bride,,,,Jain,,Mehendi,
Sharma family,Anya Sharma,bride,,,7,,kids,"Mehendi, Sangeet",
Verma,Anil Verma,Groom side,+91 99999 88888,,adult,non veg,,Wedding,
Verma,Anil Verma,Groom side,,,,,,,
,Imran Khan,both,12345,bad-email,,no onions,,Haldi,
,,bride,,,,,,,
Gupta,Neha,bride,9988776655,,,,,,`;

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("parsing", () => {
  it("parses CSV with quotes, embedded commas, newlines and semicolons", () => {
    expect(parseCsv('a,"b, c","d ""q"""\r\n1,"x\ny",3')).toEqual([
      ["a", "b, c", 'd "q"'],
      ["1", "x\ny", "3"],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads xlsx and rejects other files", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Guests");
    ws.addRow(["नाम", "मोबाइल", "परिवार"]);
    ws.addRow(["रवि", 9876543210, "शर्मा"]);
    const buf = await wb.xlsx.writeBuffer();
    const parsed = await parseSpreadsheet(buf as ArrayBuffer, "guests.xlsx");
    expect(parsed).toEqual({ headers: ["नाम", "मोबाइल", "परिवार"], rows: [["रवि", "9876543210", "शर्मा"]] });
    expect(guessMapping(parsed.headers)).toEqual({ name: 0, phone: 1, household: 2 });
    await expect(parseSpreadsheet(enc("x"), "guests.pdf")).rejects.toMatchObject({ code: "unsupported" });
    await expect(parseSpreadsheet(enc("Name\n"), "g.csv")).rejects.toMatchObject({ code: "empty" });
  });

  it("understands common Indian wedding spreadsheet values", () => {
    expect(parseSide("Ladkiwale")).toBe("bride");
    expect(parseSide("वर पक्ष")).toBe("groom");
    expect(parseSide("Mutual")).toBe("both");
    expect(parseSide("??")).toBeNull();
    expect(parseAgeGroup("1")).toBe("infant");
    expect(parseAgeGroup("7")).toBe("child");
    expect(parseAgeGroup("Kid")).toBe("child");
    expect(parseAgeGroup("45")).toBe("adult");
    expect(parseDiet("Non-Veg")).toEqual({ diet: "non_veg", notes: null });
    expect(parseDiet("Pure veg")).toEqual({ diet: "other", notes: "Pure veg" });
    expect(parseDiet("vegetarian")).toEqual({ diet: "veg", notes: null });
    expect(parseDiet("शाकाहारी")).toEqual({ diet: "veg", notes: null });
  });
});

describe("preview and import", () => {
  async function setup() {
    const host = await makeUser("host@example.com", "Asha");
    const actor = actorOf(host);
    const event = await createEvent(db(), actor, { name: "Wedding" });
    const blank = { date: null, startTime: null, endTime: null, venueName: null, venueAddress: null, mapUrl: null, dressCode: null, description: null };
    const mehendi = await createFunction(db(), event.id, actor, { name: "Mehendi", ...blank });
    const sangeet = await createFunction(db(), event.id, actor, { name: "Sangeet", ...blank });
    const wedding = await createFunction(db(), event.id, actor, { name: "Wedding", ...blank });
    // Neha is already on the list
    await createHousehold(db(), event.id, actor, {
      household: { name: "Gupta", side: "bride", address: null, city: null, postalCode: null, notes: null },
      members: [guestSchema.parse({ name: "Neha G", phone: "9988776655" })],
    });
    return { host, actor, event, mehendi, sangeet, wedding };
  }

  it("validates rows and flags duplicates", async () => {
    const { event } = await setup();
    const parsed = await parseSpreadsheet(enc(csv), "guests.csv");
    const mapping = guessMapping(parsed.headers);
    expect(mapping).toMatchObject({ household: 0, name: 1, side: 2, phone: 3, email: 4, ageGroup: 5, diet: 6, tags: 7, functions: 8, isHead: 9 });
    const uploader = await makeUser("p@example.com");
    const imp = await createImport(db(), event.id, uploader.id, "guests.csv", parsed);
    const { preview } = await previewImport(db(), event.id, imp.id);
    const byRow = new Map(preview.rows.map((r) => [r.row, r]));

    expect(byRow.get(2)).toMatchObject({ side: "bride", phone: "+919876543210", ageGroup: "adult", diet: "veg", tags: ["VIP", "elders"], isHead: true });
    expect(byRow.get(2)!.functionIds).toHaveLength(2);
    expect(byRow.get(4)).toMatchObject({ ageGroup: "child" });
    expect(byRow.get(6)!.issues).toEqual([{ kind: "skip", code: "duplicateInFile", row: 5 }]);
    expect(byRow.get(7)!.issues.map((i) => i.code).sort()).toEqual(["emailInvalid", "functionUnknown", "phoneInvalid"]);
    expect(byRow.get(7)).toMatchObject({ householdName: "Imran Khan", phone: null, email: null, diet: "other", dietNotes: "no onions" });
    expect(byRow.get(8)!.issues).toEqual([{ kind: "error", code: "missingName" }]);
    expect(byRow.get(9)!.issues).toEqual([{ kind: "skip", code: "alreadyInList", name: "Neha G" }]);
    expect(preview).toMatchObject({ importable: 5, skipped: 2, errors: 1, households: 3 });
  });

  it("requires a name column", () => {
    expect(() => buildPreview([["x"]], {}, [], [])).toThrow(ImportError);
  });

  it("imports families with invites exactly once", async () => {
    const { event, actor, mehendi, sangeet, wedding } = await setup();
    const parsed = await parseSpreadsheet(enc(csv), "guests.csv");
    const imp = await createImport(db(), event.id, actor.userId, "guests.csv", parsed);
    const result = await commitImport(db(), event.id, imp.id, actor, guessMapping(parsed.headers));
    expect(result).toEqual({ guests: 5, households: 3, skipped: 3, updated: 0, rsvps: 0 });
    await expect(commitImport(db(), event.id, imp.id, actor, guessMapping(parsed.headers))).rejects.toMatchObject({ code: "already_done" });

    const { households } = await listGuests(db(), event.id, {});
    const sharma = households.find((h) => h.name === "Sharma family")!;
    expect(sharma.side).toBe("bride");
    expect(sharma.members.map((m) => [m.name, m.isHead])).toEqual([
      ["Rajesh Sharma", true],
      ["Sunita Sharma", false],
      ["Anya Sharma", false],
    ]);
    expect(sharma.members[2].functionIds.sort()).toEqual([mehendi.id, sangeet.id].sort());
    const verma = households.find((h) => h.name === "Verma")!;
    expect(verma.members[0].functionIds).toEqual([wedding.id]);
  });

  it("exports a workbook that imports back into another event", async () => {
    const { event, actor, mehendi } = await setup();
    const parsed = await parseSpreadsheet(enc(csv), "guests.csv");
    const imp = await createImport(db(), event.id, actor.userId, "guests.csv", parsed);
    await commitImport(db(), event.id, imp.id, actor, guessMapping(parsed.headers));

    const labels = {
      headers: { name: "Name", household: "Family", side: "Side", relation: "Relation", phone: "Mobile", email: "Email", ageGroup: "Age group", diet: "Food", tags: "Tags", address: "Address", city: "City", postalCode: "PIN code", notes: "Notes", isHead: "Head of family", functions: "Functions" },
      sides: { bride: "Bride's side", groom: "Groom's side", both: "Both sides" },
      ages: { adult: "Adult", child: "Child", infant: "Infant" },
      diets: { veg: "Veg", non_veg: "Non-veg", jain: "Jain", vegan: "Vegan", other: "Other" },
      yes: "Yes", summarySheet: "Summary", guestsSheet: "Guests", functionHeader: "Function", invitedHeader: "Invited",
    };
    const rows = await listAllGuests(db(), event.id);
    const buf = await buildGuestWorkbook(rows, [{ id: mehendi.id, name: "Mehendi" }], labels);
    const back = await parseSpreadsheet(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, "export.xlsx");
    expect(back.rows).toHaveLength(6);
    const m = guessMapping(back.headers);
    for (const f of ["name", "household", "side", "phone", "email", "ageGroup", "diet", "tags", "functions", "isHead"] as const) expect(m[f]).toBeDefined();

    const other = await createEvent(db(), actor, { name: "Copy" });
    const imp2 = await createImport(db(), other.id, actor.userId, "export.xlsx", back);
    const res = await commitImport(db(), other.id, imp2.id, actor, m);
    expect(res.guests).toBe(6);
    const copy = await listAllGuests(db(), other.id);
    expect(copy.find((r) => r.guest.name === "Rajesh Sharma")).toMatchObject({ guest: { phone: "+919876543210", diet: "veg", isHead: true }, household: { side: "bride" } });
  });
});
