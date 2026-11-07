import "server-only";
import type { MessageKey, Translator } from "@/i18n/core";
import type { Tx } from "@/db";
import type { GiftFormLabels } from "@/components/gift-item-form";
import { invitedCounts, listFunctions } from "@/lib/functions";
import { assigneeOptions, GIFT_CATEGORIES, GiftError, householdOptions, QUANTITY_MODES, type GiftCtx, type GiftItemInput } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { rupeesToPaise } from "@/lib/money";
import { ForbiddenError } from "@/lib/policy";
import { ThankYouError } from "@/lib/thank-yous";
import { QuotaError } from "@/lib/outbox";

const str = (fd: FormData, name: string) => String(fd.get(name) ?? "").trim();

/** Whole number from a field; "" → null; anything else unreadable → undefined. */
function int(fd: FormData, name: string): number | null | undefined {
  const v = str(fd, name);
  if (!v) return null;
  return /^\d{1,6}$/.test(v) ? Number(v) : undefined;
}

/** Reads the gift form (GFT-01..05). Returns an error code when a number can't be read. */
export function giftFromForm(fd: FormData): GiftItemInput | "invalid" | "bad_amount" {
  const id = (name: string) => {
    const v = str(fd, name);
    return v && isUuid(v) ? v : null;
  };
  const cost = str(fd, "unitCost");
  const unitCostPaise = cost ? rupeesToPaise(cost) : null;
  if (cost && unitCostPaise === null) return "bad_amount";
  const quantityFixed = int(fd, "quantityFixed");
  const quantityExtra = int(fd, "quantityExtra");
  if (quantityFixed === undefined || quantityExtra === undefined) return "invalid";
  const category = str(fd, "category");
  const mode = str(fd, "quantityMode");
  const giveBy = str(fd, "giveBy");
  return {
    name: str(fd, "name"),
    description: str(fd, "description") || null,
    category: (GIFT_CATEGORIES as readonly string[]).includes(category) ? (category as GiftItemInput["category"]) : "other",
    functionId: id("functionId"),
    giveBy: /^\d{4}-\d{2}-\d{2}$/.test(giveBy) ? giveBy : null,
    quantityMode: (QUANTITY_MODES as readonly string[]).includes(mode) ? (mode as GiftItemInput["quantityMode"]) : "fixed",
    quantityFixed,
    quantityFunctionId: id("quantityFunctionId"),
    quantityExtra: quantityExtra ?? 0,
    forWhom: str(fd, "forWhom") || null,
    unitCostPaise,
    assigneeId: id("assigneeId"),
    source: str(fd, "source") || null,
    notes: str(fd, "notes") || null,
    // Ids are checked against the event by the domain (bad_household).
    householdIds: fd
      .getAll("householdIds")
      .map(String)
      .filter((v) => isUuid(v)),
  };
}

/** Maps domain errors to a translated message; anything else is rethrown. */
export function giftErrorText(t: Translator, e: unknown): string {
  if (e instanceof GiftError) return t(`gifts.errors.${e.code}` as MessageKey);
  if (e instanceof ThankYouError) return t(`thankYous.errors.${e.code}` as MessageKey);
  if (e instanceof QuotaError) return t("thankYous.errors.quota", { channel: t(`thankYous.channels.${e.channel}` as MessageKey) });
  if (e instanceof ForbiddenError) return t("common.notAllowed");
  throw e;
}

export const statusTone = { not_started: "neutral", drafted: "warning", sent: "success", not_needed: "neutral" } as const;
export const giftStatusTone = { to_buy: "warning", ordered: "primary", bought: "success", given: "neutral" } as const;

/** Labels for GiftItemForm. */
export function giftFormLabels(t: Translator): GiftFormLabels {
  const f = (k: Exclude<keyof GiftFormLabels, "modes" | "hint" | "save">) => t(`gifts.fields.${k}`);
  return {
    name: f("name"),
    namePlaceholder: f("namePlaceholder"),
    description: f("description"),
    category: f("category"),
    function: f("function"),
    noFunction: f("noFunction"),
    giveBy: f("giveBy"),
    giveByHelp: f("giveByHelp"),
    quantity: f("quantity"),
    quantityFixed: f("quantityFixed"),
    quantityFunction: f("quantityFunction"),
    sameFunction: f("sameFunction"),
    quantityExtra: f("quantityExtra"),
    quantityExtraHelp: f("quantityExtraHelp"),
    forWhom: f("forWhom"),
    forWhomPlaceholder: f("forWhomPlaceholder"),
    recipients: f("recipients"),
    recipientsHelp: f("recipientsHelp"),
    recipientsSearch: f("recipientsSearch"),
    recipientsCount: f("recipientsCount"),
    unitCost: f("unitCost"),
    assignee: f("assignee"),
    nobody: f("nobody"),
    source: f("source"),
    sourcePlaceholder: f("sourcePlaceholder"),
    notes: f("notes"),
    save: t("gifts.save"),
    modes: Object.fromEntries(QUANTITY_MODES.map((m) => [m, t(`gifts.modes.${m}`)])) as GiftFormLabels["modes"],
    hint: {
      per_family: t("gifts.hint.per_family"),
      per_guest: t("gifts.hint.per_guest"),
      per_adult: t("gifts.hint.per_adult"),
      spare: t("gifts.hint.spare"),
      total: t("gifts.hint.total"),
      noFunction: t("gifts.hint.noFunction"),
    },
  };
}

/** Options for GiftItemForm: categories, functions with invite counts, families, team. */
export async function giftFormOptions(db: Tx, c: GiftCtx, t: Translator) {
  const [fns, counts, households, members] = await Promise.all([listFunctions(db, c.eventId), invitedCounts(db, c.eventId), householdOptions(db, c), assigneeOptions(db, c)]);
  return {
    categories: GIFT_CATEGORIES.map((k) => ({ value: k, label: t(`gifts.categories.${k}`) })),
    functions: fns.map((f) => ({ id: f.id, name: f.name })),
    counts: Object.fromEntries([...counts].map(([id, h]) => [id, { households: h.households, guests: h.guests, adults: h.adults }])),
    households,
    members: members.map((m) => ({ id: m.id, name: m.name ?? "—" })),
  };
}
