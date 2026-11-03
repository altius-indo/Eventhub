"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getTranslator, requireUser, safeNext } from "@/lib/server/session";

export async function saveNameAction(_prev: { error?: string }, formData: FormData) {
  const { user } = await requireUser({ allowUnnamed: true });
  const { t } = await getTranslator();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!name) return { error: t("onboarding.nameLabel") };
  await getDb().update(users).set({ name, updatedAt: new Date() }).where(eq(users.id, user.id));
  redirect(safeNext(formData.get("next")));
}
