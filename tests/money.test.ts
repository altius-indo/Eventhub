import { describe, expect, it } from "vitest";
import { allocate, gstFor, percentToBps, isValidGstin, paiseToRupeesInput, rupeesToPaise, roundDiv, suggestGstType } from "@/lib/money";
import { decryptField, encryptField, mask } from "@/lib/crypto";

describe("money", () => {
  it("parses rupee input into paise", () => {
    expect(rupeesToPaise("1,23,456.5")).toBe(12345650);
    expect(rupeesToPaise("₹ 4500")).toBe(450000);
    expect(rupeesToPaise("0.05")).toBe(5);
    expect(rupeesToPaise("12.345")).toBeNull();
    expect(rupeesToPaise("-5")).toBeNull();
    expect(rupeesToPaise("")).toBeNull();
    expect(paiseToRupeesInput(450050)).toBe("4500.50");
    expect(paiseToRupeesInput(450000)).toBe("4500");
  });

  it("allocates exactly with largest remainder", () => {
    const parts = allocate(10000100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000100);
    expect(parts).toEqual([3333367, 3333367, 3333366]);
    expect(allocate(100, [0, 50, 50])).toEqual([0, 50, 50]);
    expect(allocate(101, [0, 0])).toEqual([51, 50]);
    expect(allocate(-1000, [1, 2])).toEqual([-333, -667]);
    expect(allocate(7, [])).toEqual([]);
    const big = allocate(99999999999, [123456789, 987654321, 1]);
    expect(big.reduce((a, b) => a + b, 0)).toBe(99999999999);
  });

  it("rounds half away from zero", () => {
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-3);
    expect(roundDiv(4, 3)).toBe(1);
  });

  it("computes GST per type", () => {
    expect(gstFor(10001, 1800, "cgst_sgst")).toEqual({ cgst: 900, sgst: 900, igst: 0, tax: 1800, total: 11801 });
    expect(gstFor(10001, 1800, "igst")).toEqual({ cgst: 0, sgst: 0, igst: 1800, tax: 1800, total: 11801 });
    expect(gstFor(10001, 1800, "none").tax).toBe(0);
    expect(gstFor(333, 500, "cgst_sgst").cgst).toBe(8);
    expect(gstFor(1000, 25, "igst").igst).toBe(3);
    expect(gstFor(-10001, 1800, "igst").igst).toBe(-1800);
    expect(percentToBps("18")).toBe(1800);
    expect(percentToBps("2.5")).toBe(250);
    expect(percentToBps("abc")).toBeNull();
  });

  it("validates GSTIN check digit and suggests the GST type", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false);
    expect(suggestGstType("27AAPFU0939F1ZV", "27")).toBe("cgst_sgst");
    expect(suggestGstType("27AAPFU0939F1ZV", "08")).toBe("igst");
    expect(suggestGstType(null, "08")).toBe("none");
  });

  it("encrypts fields and masks values", () => {
    const enc = encryptField("123456789012");
    expect(enc).not.toContain("123456789012");
    expect(decryptField(enc)).toBe("123456789012");
    expect(encryptField("x")).not.toBe(encryptField("x"));
    expect(mask("123456789012")).toBe("••••••••9012");
  });
});
