"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { CATEGORIES, setPrefs, type Category } from "@/lib/notifications";
import { getTranslator, requireUser } from "@/lib/server/session";

/** Saves which notification categories also come by email (MSG-05). */
export async function savePrefsAction(_p: { error?: string; info?: string }, fd: FormData) {
  const { user } = await requireUser({ allowUnnamed: true });
  const { t } = await getTranslator();
  const prefs = Object.fromEntries(CATEGORIES.map((c) => [c, fd.get(c) === "on"])) as Record<Category, boolean>;
  await setPrefs(getDb(), user.id, prefs);
  revalidatePath("/account/notifications");
  return { info: t("notifications.prefsSaved") };
}
