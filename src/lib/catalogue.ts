import { and, asc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "@/db";
import { serviceTypes, type RequirementTemplate, type ServiceType } from "@/db/schema";
import { createTranslator, type Locale, type MessageKey } from "@/i18n/core";
import { audit, type Actor } from "./audit";

/** Built-in service types (SVC-01) and standalone budget categories (BGT-02). */
export const SERVICE_KEYS = [
  "catering", "decor", "photography", "videography", "music", "makeup", "mehendi", "venue",
  "transport", "hotel", "florist", "pandit", "lighting", "security",
] as const;
export const STANDALONE_KEYS = ["gifts", "attire", "misc"] as const;
export type SystemKey = (typeof SERVICE_KEYS)[number] | (typeof STANDALONE_KEYS)[number];

export class CatalogueError extends Error {
  constructor(public code: "not_found" | "duplicate" | "in_use") {
    super(code);
  }
}

/** Parses "Title~unit|Title~unit" (translated catalogue text) into templates. */
export function parseTemplates(text: string): RequirementTemplate[] {
  return text
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [title, unit] = part.split("~").map((x) => x.trim());
      return unit ? { title, unit } : { title };
    });
}

/**
 * Seeds the built-in catalogue for an event (idempotent). Names and templates are written in
 * the given language; built-in names are also translated on display via their key.
 */
export async function ensureCatalogue(db: Tx, eventId: string, locale: Locale = "en") {
  const t = createTranslator(locale);
  const rows = [
    ...SERVICE_KEYS.map((key, i) => ({
      eventId,
      systemKey: key,
      kind: "service" as const,
      name: t(`catalogue.types.${key}` as MessageKey),
      requirementTemplates: parseTemplates(t(`catalogue.templateText.${key}` as MessageKey)),
      sortOrder: i + 1,
    })),
    ...STANDALONE_KEYS.map((key, i) => ({
      eventId,
      systemKey: key,
      kind: "standalone" as const,
      name: t(`catalogue.types.${key}` as MessageKey),
      requirementTemplates: [],
      sortOrder: 100 + i,
    })),
  ];
  await db.insert(serviceTypes).values(rows).onConflictDoNothing({ target: [serviceTypes.eventId, serviceTypes.systemKey] });
}

export async function listServiceTypes(db: Tx, eventId: string, kind?: "service" | "standalone") {
  return db
    .select()
    .from(serviceTypes)
    .where(and(eq(serviceTypes.eventId, eventId), kind ? eq(serviceTypes.kind, kind) : undefined))
    .orderBy(asc(serviceTypes.sortOrder), asc(serviceTypes.name));
}

export async function getServiceType(db: Tx, eventId: string, id: string): Promise<ServiceType> {
  const [row] = await db.select().from(serviceTypes).where(and(eq(serviceTypes.id, id), eq(serviceTypes.eventId, eventId)));
  if (!row) throw new CatalogueError("not_found");
  return row;
}

export const serviceTypeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["service", "standalone"]),
  templates: z.string().max(2000).default(""),
});

/** One requirement template per line: "Title" or "Title ~ unit". */
export function templatesFromLines(text: string): RequirementTemplate[] {
  return parseTemplates(text.split(/\r?\n/).join("|")).slice(0, 30);
}
export function templatesToLines(templates: RequirementTemplate[]): string {
  return templates.map((x) => (x.unit ? `${x.title} ~ ${x.unit}` : x.title)).join("\n");
}

async function assertUniqueName(db: Tx, eventId: string, name: string, exceptId?: string) {
  const [dup] = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.eventId, eventId), sql`lower(${serviceTypes.name}) = lower(${name})`, exceptId ? sql`${serviceTypes.id} <> ${exceptId}` : undefined));
  if (dup) throw new CatalogueError("duplicate");
}

export async function addServiceType(db: Database, eventId: string, actor: Actor, input: z.infer<typeof serviceTypeSchema>) {
  return db.transaction(async (tx) => {
    await assertUniqueName(tx, eventId, input.name);
    const [{ m }] = await tx.select({ m: max(serviceTypes.sortOrder) }).from(serviceTypes).where(eq(serviceTypes.eventId, eventId));
    const [row] = await tx
      .insert(serviceTypes)
      .values({ eventId, name: input.name, kind: input.kind, requirementTemplates: templatesFromLines(input.templates), sortOrder: (m ?? 0) + 1 })
      .returning();
    await audit(tx, { eventId, actor, action: "service_type.created", entityType: "service_type", entityId: row.id, data: { name: row.name } });
    return row;
  });
}

export async function updateServiceType(db: Database, eventId: string, id: string, input: { name: string; templates: string }) {
  return db.transaction(async (tx) => {
    const row = await getServiceType(tx, eventId, id);
    // Built-in names are translated on display; a custom name for them is kept but rarely needed.
    await assertUniqueName(tx, eventId, input.name, id);
    await tx
      .update(serviceTypes)
      .set({ name: input.name, requirementTemplates: templatesFromLines(input.templates) })
      .where(eq(serviceTypes.id, row.id));
  });
}

/** Per-category auto-approve threshold (BGT-04). Hosts only; 0 = every Planner change needs a Host. */
export async function setThreshold(db: Database, eventId: string, actor: Actor, id: string, amountPaise: number) {
  if (!Number.isInteger(amountPaise) || amountPaise < 0) throw new CatalogueError("not_found");
  return db.transaction(async (tx) => {
    const row = await getServiceType(tx, eventId, id);
    if (row.autoApproveBelowPaise === amountPaise) return;
    await tx.update(serviceTypes).set({ autoApproveBelowPaise: amountPaise }).where(eq(serviceTypes.id, id));
    await audit(tx, {
      eventId,
      actor,
      action: "threshold.changed",
      entityType: "service_type",
      entityId: id,
      data: { name: row.name, from: row.autoApproveBelowPaise, to: amountPaise },
    });
  });
}
