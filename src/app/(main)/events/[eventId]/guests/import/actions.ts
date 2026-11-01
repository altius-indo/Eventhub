"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  commitImport,
  createImport,
  getImport,
  ImportError,
  importFields,
  parseSpreadsheet,
  type ColumnMapping,
} from "@/lib/guest-import";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { eq } from "drizzle-orm";
import { guestImports } from "@/db/schema";

type State = { error?: string; info?: string };

async function importErrorMessage(err: unknown): Promise<State> {
  const { t } = await getTranslator();
  if (err instanceof ImportError) return { error: t(`importer.errors.${err.code}`) };
  throw err;
}

export async function uploadImportAction(eventId: string, _prev: State, formData: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("guests.edit")) return { error: t("common.notAllowed") };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: t("importer.errors.empty") };
  let id: string;
  try {
    const parsed = await parseSpreadsheet(await file.arrayBuffer(), file.name);
    ({ id } = await createImport(getDb(), eventId, ctx.user.id, file.name, parsed));
  } catch (err) {
    return importErrorMessage(err);
  }
  redirect(`/events/${eventId}/guests/import/${id}`);
}

function readMapping(formData: FormData): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const field of importFields) {
    const v = formData.get(`map_${field}`);
    if (v !== null && v !== "" && Number.isInteger(Number(v))) mapping[field] = Number(v);
  }
  return mapping;
}

export async function updateMappingAction(eventId: string, importId: string, formData: FormData) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("guests.edit")) return;
  const imp = await getImport(getDb(), eventId, importId);
  if (imp.completedAt) return;
  await getDb().update(guestImports).set({ mapping: readMapping(formData) }).where(eq(guestImports.id, importId));
  revalidatePath(`/events/${eventId}/guests/import/${importId}`);
}

export async function commitImportAction(eventId: string, importId: string, _prev: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("guests.edit")) return { error: t("common.notAllowed") };
  let result: { guests: number; households: number; skipped: number };
  try {
    const imp = await getImport(getDb(), eventId, importId);
    result = await commitImport(getDb(), eventId, importId, ctx.actor, imp.mapping ?? {});
  } catch (err) {
    return importErrorMessage(err);
  }
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/guests?imported=${result.guests}.${result.households}.${result.skipped}`);
}
