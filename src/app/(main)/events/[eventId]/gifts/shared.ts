import "server-only";
import type { MessageKey, Translator } from "@/i18n/core";
import { GiftError, GIFT_TYPES, RECEIVED_FOR, type GiftInput } from "@/lib/gifts";
import { GiftImportError } from "@/lib/gift-import";
import { isUuid } from "@/lib/ids";
import { rupeesToPaise } from "@/lib/money";
import { ForbiddenError } from "@/lib/policy";
import { ThankYouError } from "@/lib/thank-yous";
import { QuotaError } from "@/lib/outbox";

const str = (fd: FormData, name: string) => String(fd.get(name) ?? "").trim();

/** Rupees → paise; "" → null; invalid → undefined. */
export function paise(fd: FormData, name: string): number | null | undefined {
  const v = str(fd, name);
  if (!v) return null;
  return rupeesToPaise(v) ?? undefined;
}

/** Reads the gift form. Returns null when an amount can't be read. */
export function giftFromForm(fd: FormData): GiftInput | null {
  const amountPaise = paise(fd, "amount");
  const estValuePaise = paise(fd, "estValue");
  if (amountPaise === undefined || estValuePaise === undefined) return null;
  const id = (name: string) => {
    const v = str(fd, name);
    return v && isUuid(v) ? v : null;
  };
  const type = str(fd, "type");
  const receivedFor = str(fd, "receivedFor");
  const date = str(fd, "receivedOn");
  return {
    householdId: id("householdId"),
    giverName: str(fd, "giverName") || null,
    type: (GIFT_TYPES as readonly string[]).includes(type) ? (type as GiftInput["type"]) : "cash",
    amountPaise,
    itemDescription: str(fd, "itemDescription") || null,
    estValuePaise,
    functionId: id("functionId"),
    receivedFor: (RECEIVED_FOR as readonly string[]).includes(receivedFor) ? (receivedFor as GiftInput["receivedFor"]) : "couple",
    receivedForNote: str(fd, "receivedForNote") || null,
    envelopeNo: str(fd, "envelopeNo") || null,
    receivedOn: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    notes: str(fd, "notes") || null,
  };
}

/** Maps domain errors to a translated message; anything else is rethrown. */
export function giftErrorText(t: Translator, e: unknown): string {
  if (e instanceof GiftError) return t(`gifts.errors.${e.code}` as MessageKey);
  if (e instanceof GiftImportError) return t(`gifts.import.errors.${e.code}` as MessageKey);
  if (e instanceof ThankYouError) return t(`thankYous.errors.${e.code}` as MessageKey);
  if (e instanceof QuotaError) return t("thankYous.errors.quota", { channel: t(`thankYous.channels.${e.channel}` as MessageKey) });
  if (e instanceof ForbiddenError) return t("common.notAllowed");
  throw e;
}

export function typeLabel(t: Translator, type: string) {
  return t(`gifts.types.${type}` as MessageKey);
}
export function forLabel(t: Translator, f: string) {
  return t(`gifts.for.${f}` as MessageKey);
}

/** Labels for GiftFields. */
export function giftFieldLabels(t: Translator) {
  return {
    household: t("gifts.household"),
    householdNone: t("gifts.householdNone"),
    giverName: t("gifts.giverName"),
    giverHelp: t("gifts.giverHelp"),
    type: t("gifts.type"),
    types: Object.fromEntries(GIFT_TYPES.map((k) => [k, typeLabel(t, k)])) as Record<(typeof GIFT_TYPES)[number], string>,
    amount: t("gifts.amount"),
    amountHelp: t("gifts.amountHelp"),
    itemDescription: t("gifts.itemDescription"),
    estValue: t("gifts.estValue"),
    function: t("gifts.function"),
    noFunction: t("gifts.noFunction"),
    receivedFor: t("gifts.receivedFor"),
    receivedFors: Object.fromEntries(RECEIVED_FOR.map((k) => [k, forLabel(t, k)])) as Record<(typeof RECEIVED_FOR)[number], string>,
    receivedForNote: t("gifts.receivedForNote"),
    envelopeNo: t("gifts.envelopeNo"),
    receivedOn: t("gifts.receivedOn"),
    notes: t("gifts.notes"),
  };
}

export const statusTone = { not_started: "neutral", drafted: "warning", sent: "success", not_needed: "neutral" } as const;
