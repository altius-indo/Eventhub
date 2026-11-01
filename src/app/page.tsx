import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { listEventsForUser } from "@/lib/events";
import { getSessionContext } from "@/lib/server/session";
import { vendorLinksForUser } from "@/lib/vendor-access";

export default async function Home() {
  const ctx = await getSessionContext();
  if (!ctx) redirect("/login");
  // Vendor-only logins land in their portal (VND-10).
  const db = getDb();
  if ((await listEventsForUser(db, ctx.user.id)).active.length === 0 && (await vendorLinksForUser(db, ctx.user.id)).length > 0) redirect("/vendor");
  redirect("/events");
}
