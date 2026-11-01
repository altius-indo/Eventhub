import { describe, expect, it } from "vitest";
import { formatIdentifier, maskIdentifier, parseIdentifier } from "@/lib/identifiers";

describe("parseIdentifier", () => {
  it("normalises Indian mobile numbers to E.164", () => {
    expect(parseIdentifier("98765 43210")).toEqual({ type: "phone", value: "+919876543210" });
    expect(parseIdentifier("+91-98765-43210")).toEqual({ type: "phone", value: "+919876543210" });
    expect(parseIdentifier("09876543210")).toEqual({ type: "phone", value: "+919876543210" });
  });

  it("accepts international numbers with a country code", () => {
    expect(parseIdentifier("+1 415 555 2671")).toEqual({ type: "phone", value: "+14155552671" });
  });

  it("lower-cases emails", () => {
    expect(parseIdentifier("  Priya.Sharma@Example.COM ")).toEqual({ type: "email", value: "priya.sharma@example.com" });
  });

  it("rejects junk", () => {
    expect(parseIdentifier("")).toBeNull();
    expect(parseIdentifier("hello")).toBeNull();
    expect(parseIdentifier("12345")).toBeNull();
    expect(parseIdentifier("a@b")).toBeNull();
  });

  it("masks and formats", () => {
    expect(maskIdentifier({ type: "email", value: "priya@example.com" })).toBe("pr•••@example.com");
    expect(maskIdentifier({ type: "phone", value: "+919876543210" })).toBe("+91 •••••3210");
    expect(formatIdentifier({ type: "phone", value: "+919876543210" })).toBe("+91 98765 43210");
  });
});
