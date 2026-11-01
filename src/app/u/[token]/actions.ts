"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { unsubscribe } from "@/lib/broadcasts";
import { getRequestMeta } from "@/lib/server/session";
import { allowAttempt } from "@/lib/website";

/** Opts the address in a signed link out of broadcasts. Same outcome page whether valid or not. */
export async function unsubscribeAction(token: string) {
  const db = getDb();
  const { ip } = await getRequestMeta();
  if (await allowAttempt(db, "unsubscribe", ip ?? "unknown", 30, 60 * 60 * 1000)) await unsubscribe(db, token);
  redirect(`/u/${encodeURIComponent(token.slice(0, 600))}?done=1`);
}
