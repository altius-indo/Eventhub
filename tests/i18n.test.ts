import { describe, expect, it } from "vitest";
import { createTranslator, formatInr, translateDynamic } from "@/i18n/core";
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
  });
});
