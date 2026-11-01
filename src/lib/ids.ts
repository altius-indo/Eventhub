const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict UUID check for ids that come from URLs, forms or bound action arguments. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Keeps only well-formed UUIDs (form-posted id lists). */
export function uuids(values: unknown[]): string[] {
  return values.map(String).filter(isUuid);
}
