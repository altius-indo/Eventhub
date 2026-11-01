import { StorageError } from "./types";

/**
 * Object keys (ADR-0030). Every key lives under `events/<eventId>/`, so retention (EVT-07) and
 * event deletion are one prefix delete, and a household's files sit under
 * `events/<eventId>/households/<householdId>/` so guest erasure (EVT-09) is one prefix delete too.
 *
 * Conventions (WP-B gallery should follow them):
 * - `events/<eid>/documents/<documentId>`                     contracts, invoices, receipts …
 * - `events/<eid>/households/<hid>/...`                      anything uploaded by / about a family
 * - `events/<eid>/gallery/...`                               professional / member media
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}";
const KEY_RE = new RegExp(`^events/${UUID}/(?:${SEGMENT}/)*${SEGMENT}$`);
const PREFIX_RE = new RegExp(`^events/${UUID}/(?:${SEGMENT}/)*$`);

export function isValidKey(key: string): boolean {
  return key.length <= 1024 && KEY_RE.test(key);
}

export function isValidPrefix(prefix: string): boolean {
  return prefix.length <= 1024 && PREFIX_RE.test(prefix);
}

export function assertKey(key: string): string {
  if (!isValidKey(key)) throw new StorageError("bad_key");
  return key;
}

export function assertPrefix(prefix: string): string {
  if (!isValidPrefix(prefix)) throw new StorageError("bad_key");
  return prefix;
}

const seg = (id: string) => {
  if (!new RegExp(`^${SEGMENT}$`).test(id)) throw new StorageError("bad_key");
  return id;
};

export const eventPrefix = (eventId: string) => assertPrefix(`events/${eventId}/`);
export const householdPrefix = (eventId: string, householdId: string) => assertPrefix(`events/${eventId}/households/${seg(householdId)}/`);
export const documentsPrefix = (eventId: string) => assertPrefix(`events/${eventId}/documents/`);
export const documentKey = (eventId: string, documentId: string) => assertKey(`events/${eventId}/documents/${seg(documentId)}`);

/** Builds a key under an event from server-chosen segments (each validated). */
export function eventKey(eventId: string, ...segments: string[]) {
  return assertKey(`events/${eventId}/${segments.map(seg).join("/")}`);
}

/** The event id a key belongs to (keys are validated first). */
export function eventIdOfKey(key: string): string | null {
  return isValidKey(key) || isValidPrefix(key) ? key.split("/")[1] : null;
}
