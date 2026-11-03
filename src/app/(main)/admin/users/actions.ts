"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { revokeAllSessions } from "@/lib/auth-core";
import { getTranslator, requireAppAdmin, requireStepUp } from "@/lib/server/session";

type State = { error?: string; info?: string };
const ops = ["suspend", "reactivate", "grant_admin", "revoke_admin"] as const;
type Op = (typeof ops)[number];

export async function adminUserAction(_prev: State, formData: FormData): Promise<State> {
  const ctx = await requireAppAdmin();
  const { t } = await getTranslator();
  const op = formData.get("op") as Op;
  const userId = String(formData.get("userId"));
  if (!ops.includes(op)) return { error: t("common.somethingWrong") };
  if (userId === ctx.user.id) return { error: t("admin.cannotSelf") };
  await requireStepUp(ctx, `/admin/users?q=${encodeURIComponent(String(formData.get("q") ?? ""))}`);

  const db = getDb();
  await db.transaction(async (tx) => {
    const now = new Date();
    const patch =
      op === "suspend"
        ? { suspendedAt: now }
        : op === "reactivate"
          ? { suspendedAt: null }
          : { isAppAdmin: op === "grant_admin" };
    const [updated] = await tx.update(users).set({ ...patch, updatedAt: now }).where(eq(users.id, userId)).returning();
    if (!updated) return;
    if (op === "suspend") await revokeAllSessions(tx, userId);
    await audit(tx, {
      actor: { userId: ctx.user.id, isAppAdmin: true },
      action: `admin.user_${op}`,
      entityType: "user",
      entityId: userId,
    });
  });
  revalidatePath("/admin/users");
  return { info: t("common.saved") };
}
