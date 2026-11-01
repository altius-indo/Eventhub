"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { addServiceType, CatalogueError, serviceTypeSchema, updateServiceType } from "@/lib/catalogue";
import { isUuid } from "@/lib/ids";
import { ForbiddenError } from "@/lib/policy";
import {
  addRequirement,
  addService,
  cancelRequirement,
  cancelService,
  copyService,
  markDelivered,
  requirementSchema,
  ServiceError,
  updateRequirement,
  updateServiceDetails,
  type RequirementInput,
} from "@/lib/services";
import { getEventContext } from "@/lib/server/event-context";
import { dctx, intField, optStr, paiseField, payerField, resultInfo } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";

type State = { error?: string; info?: string };
type T = Awaited<ReturnType<typeof getTranslator>>["t"];

const refresh = (eventId: string) => revalidatePath(`/events/${eventId}`, "layout");

function fail(t: T, e: unknown): State {
  if (e instanceof ServiceError) return { error: t(`services.errors.${e.code}`) };
  if (e instanceof CatalogueError) return { error: e.code === "duplicate" ? t("catalogue.duplicate") : t("services.errors.invalid") };
  if (e instanceof ForbiddenError) return { error: t("common.notAllowed") };
  throw e;
}

async function editor(eventId: string, ...ids: string[]) {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  return { ctx, t, ok: ctx.can("services.edit") && ids.every(isUuid) };
}

function requirementFrom(fd: FormData): RequirementInput | null {
  const quantity = intField(fd, "quantity");
  const estimate = paiseField(fd, "estimate");
  if (quantity === undefined || estimate === undefined) return null;
  const parsed = requirementSchema.safeParse({
    title: String(fd.get("title") ?? ""),
    quantity,
    unit: optStr(fd, "unit"),
    specs: optStr(fd, "specs"),
    startsAt: optStr(fd, "startsAt"),
    endsAt: optStr(fd, "endsAt"),
    venue: optStr(fd, "venue"),
    estimatePaise: estimate,
    priority: fd.get("priority") === "nice" ? "nice" : "must",
    payer: payerField(fd),
  });
  return parsed.success ? parsed.data : null;
}

export async function addServiceAction(eventId: string, functionId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, functionId);
  const typeId = String(fd.get("serviceTypeId") ?? "");
  const owner = String(fd.get("ownerUserId") ?? "");
  if (!ok || !isUuid(typeId) || (owner && !isUuid(owner))) return { error: t("common.notAllowed") };
  let id: string;
  try {
    const r = await addService(getDb(), dctx(ctx), {
      functionId,
      serviceTypeId: typeId,
      name: optStr(fd, "name"),
      ownerUserId: owner || null,
      useTemplates: fd.get("useTemplates") === "on",
    });
    id = r.service.id;
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/services/${id}`);
}

export async function updateServiceAction(eventId: string, serviceId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, serviceId);
  const owner = String(fd.get("ownerUserId") ?? "");
  if (!ok || (owner && !isUuid(owner))) return { error: t("common.notAllowed") };
  const payer = payerField(fd);
  if (payer === undefined) return { error: t("payer.invalid") };
  try {
    await updateServiceDetails(getDb(), dctx(ctx), serviceId, { name: optStr(fd, "name"), ownerUserId: owner || null, brief: optStr(fd, "brief"), payer });
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function addRequirementAction(eventId: string, serviceId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, serviceId);
  if (!ok) return { error: t("common.notAllowed") };
  if (payerField(fd) === undefined) return { error: t("payer.invalid") };
  const input = requirementFrom(fd);
  if (!input) return { error: t("services.errors.invalid") };
  try {
    const r = await addRequirement(getDb(), dctx(ctx), serviceId, input);
    refresh(eventId);
    return { info: resultInfo(t, r.result) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function updateRequirementAction(eventId: string, requirementId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, requirementId);
  if (!ok) return { error: t("common.notAllowed") };
  if (payerField(fd) === undefined) return { error: t("payer.invalid") };
  const input = requirementFrom(fd);
  if (!input) return { error: t("services.errors.invalid") };
  try {
    const r = await updateRequirement(getDb(), dctx(ctx), requirementId, input);
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function cancelRequirementAction(eventId: string, requirementId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, requirementId);
  if (!ok) return { error: t("common.notAllowed") };
  try {
    const r = await cancelRequirement(getDb(), dctx(ctx), requirementId, String(fd.get("reason") ?? ""));
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function cancelServiceAction(eventId: string, serviceId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, serviceId);
  if (!ok) return { error: t("common.notAllowed") };
  try {
    const r = await cancelService(getDb(), dctx(ctx), serviceId, String(fd.get("reason") ?? ""));
    refresh(eventId);
    return { info: resultInfo(t, r) };
  } catch (e) {
    return fail(t, e);
  }
}

export async function deliveredAction(eventId: string, requirementId: string, delivered: boolean) {
  const ctx = await getEventContext(eventId);
  if (!isUuid(requirementId)) return;
  await markDelivered(getDb(), dctx(ctx), requirementId, delivered).catch((e) => {
    if (!(e instanceof ServiceError)) throw e;
  });
  refresh(eventId);
}

export async function copyServiceAction(eventId: string, serviceId: string, _p: State, fd: FormData): Promise<State> {
  const { ctx, t, ok } = await editor(eventId, serviceId);
  const to = String(fd.get("functionId") ?? "");
  if (!ok || !isUuid(to)) return { error: t("common.notAllowed") };
  let id: string;
  try {
    id = (await copyService(getDb(), dctx(ctx), serviceId, to)).service.id;
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  redirect(`/events/${eventId}/services/${id}`);
}

export async function addTypeAction(eventId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("services.catalogue")) return { error: t("common.notAllowed") };
  const parsed = serviceTypeSchema.safeParse({ name: String(fd.get("name") ?? ""), kind: fd.get("kind") === "standalone" ? "standalone" : "service", templates: String(fd.get("templates") ?? "") });
  if (!parsed.success) return { error: t("services.errors.invalid") };
  try {
    await addServiceType(getDb(), eventId, ctx.actor, parsed.data);
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}

export async function updateTypeAction(eventId: string, typeId: string, _p: State, fd: FormData): Promise<State> {
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  if (!ctx.can("services.catalogue") || !isUuid(typeId)) return { error: t("common.notAllowed") };
  const name = String(fd.get("name") ?? "").trim();
  if (!name || name.length > 60) return { error: t("services.errors.invalid") };
  try {
    await updateServiceType(getDb(), eventId, typeId, { name, templates: String(fd.get("templates") ?? "").slice(0, 2000) });
  } catch (e) {
    return fail(t, e);
  }
  refresh(eventId);
  return { info: t("common.saved") };
}
