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
  saveImportSettings,
  type ColumnMapping,
  type ColumnMode,
  type ImportResult,
  type ImportSettings,
} from "@/lib/guest-import";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

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

function readSettings(formData: FormData): ImportSettings {
  const col = (v: FormDataEntryValue | null) => (typeof v === "string" && v !== "" && Number.isInteger(Number(v)) ? Number(v) : undefined);
  const mapping: ColumnMapping = {};
  for (const field of importFields) {
    const c = col(formData.get(`map_${field}`));
    if (c !== undefined) mapping[field] = c;
  }
  const functionColumns: Record<string, number> = {};
  for (const [k, v] of formData.entries()) {
    const m = k.match(/^fncol_(.+)$/);
    const c = col(v);
    if (m && c !== undefined) functionColumns[m[1]] = c;
  }
  // A column's meaning (replies or invitations) follows detection until someone picks the other one.
  const functionColumnModes: Record<string, ColumnMode> = {};
  for (const fnId of Object.keys(functionColumns)) {
    const chosen = formData.get(`fnmode_${fnId}`);
    if (chosen !== "replies" && chosen !== "invites") continue;
    if (formData.get(`fnmode_stored_${fnId}`) === "auto" && formData.get(`fnmode_default_${fnId}`) === chosen) continue;
    functionColumnModes[fnId] = chosen;
  }
  const inviteAll = [...new Set(formData.getAll("inviteAll").filter((v): v is string => typeof v === "string"))];
  // "Update existing" follows the file (on when it has invite/RSVP data) until someone changes the box.
  const checked = formData.get("updateExisting") === "1";
  const stored = formData.get("updateExisting_stored");
  const shownDefault = formData.get("updateExisting_default") === "1";
  const updateExisting = stored === "auto" && checked === shownDefault ? null : checked;
  return { mapping, functionColumns, functionColumnModes, inviteAll, updateExisting };
}

export async function updateMappingAction(eventId: string, importId: string, formData: FormData) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("guests.edit")) return;
  try {
    await saveImportSettings(getDb(), eventId, importId, readSettings(formData));
  } catch (err) {
    // A stale or tampered form (e.g. a function deleted meanwhile): keep the saved settings.
    if (!(err instanceof ImportError)) throw err;
    if (err.code === "not_found") return;
  }
  revalidatePath(`/events/${eventId}/guests/import/${importId}`);
}

export async function commitImportAction(eventId: string, importId: string, _prev: State): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("guests.edit")) return { error: t("common.notAllowed") };
  let result: ImportResult;
  try {
    const imp = await getImport(getDb(), eventId, importId);
    result = await commitImport(getDb(), eventId, importId, ctx.actor, imp.mapping ?? {});
  } catch (err) {
    return importErrorMessage(err);
  }
  revalidatePath(`/events/${eventId}`, "layout");
  redirect(`/events/${eventId}/guests?imported=${[result.guests, result.households, result.skipped, result.rsvps, result.updated].join(".")}`);
}
