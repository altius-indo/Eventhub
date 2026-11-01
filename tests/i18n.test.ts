import { describe, expect, it } from "vitest";
import { createTranslator, formatInr, formatInrShort, translateDynamic } from "@/i18n/core";
import en from "@/i18n/messages/en";
import hi from "@/i18n/messages/hi";

function leaves(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (typeof v === "string" ? [`${prefix}${k}`] : leaves(v, `${prefix}${k}.`)));
}

describe("i18n", () => {
  it("Hindi has every English key and no empty strings", () => {
    expect(leaves(hi).sort()).toEqual(leaves(en).sort());
    for (const k of leaves(hi)) expect(translateDynamic("hi", k)).toBeTruthy();
  });

  it("keeps placeholders consistent between languages", () => {
    for (const k of leaves(en)) {
      const vars = (s: string | undefined) => (s?.match(/\{\w+\}/g) ?? []).sort().join(",");
      expect(vars(translateDynamic("hi", k)), k).toBe(vars(translateDynamic("en", k)));
    }
  });

  it("interpolates and resolves keys containing dots", () => {
    const t = createTranslator("en");
    expect(t("auth.verify.sentTo", { to: "x@y.com" })).toBe("We sent a 6-digit code to x@y.com.");
    expect(t("audit.actions.event.created")).toBe("created the event");
    expect(createTranslator("hi")("roles.host")).toBe("होस्ट");
  });

  it("formats rupees with Indian grouping", () => {
    expect(formatInr("en", 123456700)).toBe("₹12,34,567");
    expect(formatInrShort("en", 1250000_00)).toBe("₹12.5 L");
    expect(formatInrShort("en", 12500000_00)).toBe("₹1.25 Cr");
    expect(formatInrShort("hi", 12500000_00)).toBe("₹1.25 करोड़");
    expect(formatInrShort("en", 50000_00)).toBe("₹50,000");
  });
});
