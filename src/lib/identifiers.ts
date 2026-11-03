import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import type { IdentifierType } from "@/db/schema";

export type Identifier = { type: IdentifierType; value: string };

const emailSchema = z.email();

/**
 * Normalises a user-entered phone number or email.
 * Phones default to India (+91) and are stored in E.164; emails are lower-cased.
 */
export function parseIdentifier(raw: string): Identifier | null {
  const input = raw.trim();
  if (!input) return null;
  if (input.includes("@")) {
    const value = input.toLowerCase();
    return emailSchema.safeParse(value).success ? { type: "email", value } : null;
  }
  if (!/^[+\d\s().-]{6,}$/.test(input)) return null;
  const phone = parsePhoneNumberFromString(input, "IN");
  if (!phone || !phone.isValid()) return null;
  return { type: "phone", value: phone.number };
}

/** Partially hides an identifier for display, e.g. "ra•••@gmail.com" or "+91 ••••• •3210". */
export function maskIdentifier(id: Identifier): string {
  if (id.type === "email") {
    const [local, domain] = id.value.split("@");
    return `${local.slice(0, 2)}•••@${domain}`;
  }
  return `${id.value.slice(0, 3)} •••••${id.value.slice(-4)}`;
}

/** Pretty-prints an identifier in full. */
export function formatIdentifier(id: Identifier): string {
  if (id.type === "email") return id.value;
  const phone = parsePhoneNumberFromString(id.value);
  return phone ? phone.formatInternational() : id.value;
}
