import en, { type Messages } from "./messages/en";
import hi from "./messages/hi";

export const locales = ["en", "hi"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "eh_locale";

const catalogues: Record<Locale, Messages> = { en, hi };

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<Messages>;
export type TranslateVars = Record<string, string | number>;
export type Translator = (key: MessageKey, vars?: TranslateVars) => string;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  // Keys like "audit.actions.event.created" contain dots inside the leaf name,
  // so walk greedily: try the longest remaining segment first.
  const parts = key.split(".");
  let i = 0;
  while (i < parts.length) {
    if (typeof node !== "object" || node === null) return undefined;
    let matched = false;
    for (let j = parts.length; j > i; j--) {
      const candidate = parts.slice(i, j).join(".");
      if (candidate in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[candidate];
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) return undefined;
  }
  return typeof node === "string" ? node : undefined;
}

export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export function createTranslator(locale: Locale): Translator {
  const messages = catalogues[locale];
  return (key, vars) => interpolate(lookup(messages, key) ?? lookup(en, key) ?? key, vars);
}

/** Translates a dynamic key (e.g. an audit action) that isn't known at compile time. */
export function translateDynamic(locale: Locale, key: string, vars?: TranslateVars): string | undefined {
  const raw = lookup(catalogues[locale], key) ?? lookup(en, key);
  return raw === undefined ? undefined : interpolate(raw, vars);
}

export function intlLocale(locale: Locale): string {
  return locale === "hi" ? "hi-IN" : "en-IN";
}

export function formatDate(locale: Locale, value: Date | string, opts?: Intl.DateTimeFormatOptions): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: "medium",
    timeZone: "Asia/Kolkata",
    ...opts,
  }).format(date);
}

export function formatDateTime(locale: Locale, value: Date): string {
  return formatDate(locale, value, { dateStyle: "medium", timeStyle: "short" });
}

/** Indian-grouped currency, e.g. ₹12,34,567. */
export function formatInr(locale: Locale, paise: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
}

/** Lakh/crore short form (BGT-06): ₹12.5 L, ₹1.25 Cr (Hindi: लाख, करोड़); full form below ₹1 lakh. */
export function formatInrShort(locale: Locale, paise: number): string {
  const rupees = Math.abs(paise) / 100;
  const sign = paise < 0 ? "-" : "";
  const num = (v: number) => new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 2 }).format(v);
  if (rupees >= 1_00_00_000) return `${sign}₹${num(rupees / 1_00_00_000)} ${locale === "hi" ? "करोड़" : "Cr"}`;
  if (rupees >= 1_00_000) return `${sign}₹${num(rupees / 1_00_000)} ${locale === "hi" ? "लाख" : "L"}`;
  return formatInr(locale, paise);
}

/** "16:00" → "4:00 pm" (en-IN) / "4:00 pm" (hi-IN). */
export function formatTime(locale: Locale, hhmm: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(
    new Date(`1970-01-01T${hhmm.slice(0, 5)}:00Z`),
  );
}

/** A plain calendar date ("2026-12-10") formatted without timezone shifts. */
export function formatDay(locale: Locale, isoDate: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...opts, timeZone: "UTC" }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** Formats a wall-clock Date (event-local time stored as UTC fields) without shifting it. */
export function formatWallClock(locale: Locale, d: Date, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...opts, timeZone: "UTC" }).format(d);
}
