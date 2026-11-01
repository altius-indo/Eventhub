import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userIdentifiers } from "@/db/schema";
import { maskIdentifier } from "@/lib/identifiers";
import { readFlowCookie } from "@/lib/server/session";

export const STEP_UP_FLOW = "eh_stepup";
export type StepUpFlow = { c: string; identifierId: string; next: string };

/** Where the pending step-up code was sent, masked, or null if none is pending. */
export async function stepUpFlowTarget(userId: string) {
  const flow = await readFlowCookie<StepUpFlow>(STEP_UP_FLOW);
  if (!flow) return null;
  const [identifier] = await getDb().select().from(userIdentifiers).where(eq(userIdentifiers.id, flow.identifierId));
  return identifier && identifier.userId === userId ? maskIdentifier(identifier) : null;
}
