/**
 * Money helpers. All amounts are integer paise; nothing here uses floating-point
 * arithmetic on money except to parse user input.
 */

/** Parses a rupee amount typed by a person ("1,23,456.50", "₹ 4500") into paise. */
export function rupeesToPaise(input: string): number | null {
  const s = input.replace(/[₹,\s]/g, "");
  if (s === "") return null;
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(s)) return null;
  const [r, p = ""] = s.split(".");
  return Number(r) * 100 + Number(p.padEnd(2, "0"));
}

/** Paise as a plain rupee string for form inputs ("4500.5" -> "4500.50"). */
export function paiseToRupeesInput(paise: number | null | undefined): string {
  if (paise == null) return "";
  const sign = paise < 0 ? "-" : "";
  const a = Math.abs(paise);
  const r = Math.floor(a / 100);
  const p = a % 100;
  return p ? `${sign}${r}.${String(p).padStart(2, "0")}` : `${sign}${r}`;
}

/**
 * Splits `total` across `weights` so the parts add up to `total` exactly
 * (largest remainder; ties go to the earlier item). All weights 0 -> equal split.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total)) throw new Error("allocate: total must be integer paise");
  const n = weights.length;
  if (n === 0) return [];
  const w = weights.map((x) => Math.max(0, x));
  let sum = w.reduce((a, b) => a + b, 0);
  const ws = sum === 0 ? w.map(() => 1) : w;
  if (sum === 0) sum = n;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  // BigInt keeps products exact for large weights.
  const exact = ws.map((x) => (BigInt(abs) * BigInt(Math.round(x))) / BigInt(Math.round(sum)));
  const rem = ws.map((x, i) => BigInt(abs) * BigInt(Math.round(x)) - exact[i] * BigInt(Math.round(sum)));
  const parts = exact.map(Number);
  let left = abs - parts.reduce((a, b) => a + b, 0);
  const order = rem.map((r, i) => ({ r, i })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (let k = 0; left > 0; k = (k + 1) % n, left--) parts[order[k].i]++;
  return parts.map((p) => p * sign);
}

/** Percentage (0-100, up to 2 decimals) of an amount, rounded half-up to the paisa. */
export function percentOf(amount: number, percentBasisPoints: number): number {
  // basis points: 18% = 1800
  return roundDiv(amount * percentBasisPoints, 10_000);
}

/** Integer division rounded half away from zero. */
export function roundDiv(a: number, b: number): number {
  const q = Math.trunc(a / b);
  const r = a - q * b;
  if (Math.abs(r) * 2 >= Math.abs(b)) return q + (a < 0 !== b < 0 ? -1 : 1);
  return q;
}

export type GstType = "none" | "cgst_sgst" | "igst";
export const GST_RATES = [0, 5, 12, 18, 28] as const;

/**
 * Tax on a taxable amount. CGST and SGST are each half the rate, computed and
 * rounded separately (as printed on Indian invoices).
 */
export function gstFor(taxable: number, ratePercent: number, type: GstType) {
  if (type === "none" || ratePercent === 0) return { cgst: 0, sgst: 0, igst: 0, tax: 0, total: taxable };
  if (type === "igst") {
    const igst = roundDiv(taxable * ratePercent, 100);
    return { cgst: 0, sgst: 0, igst, tax: igst, total: taxable + igst };
  }
  const half = roundDiv(taxable * ratePercent, 200);
  return { cgst: half, sgst: half, igst: 0, tax: half * 2, total: taxable + half * 2 };
}

/** State code (first two digits) of a GSTIN, or null. */
export function gstinState(gstin: string | null | undefined): string | null {
  return gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null;
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** GSTIN format and check digit (15 characters). */
export function isValidGstin(value: string): boolean {
  const g = value.toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  return check === g[14];
}

export function isValidPan(value: string): boolean {
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(value.toUpperCase());
}

/** Indian state/UT GST codes, for the event's place of supply. */
export const GST_STATES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};

/** Suggested GST type: same state -> CGST+SGST, different -> IGST, no GSTIN -> none. */
export function suggestGstType(vendorGstin: string | null | undefined, placeOfSupply: string | null | undefined): GstType {
  const s = gstinState(vendorGstin);
  if (!s) return "none";
  if (!placeOfSupply) return "cgst_sgst";
  return s === placeOfSupply ? "cgst_sgst" : "igst";
}
