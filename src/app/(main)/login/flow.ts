import "server-only";
import type { Identifier } from "@/lib/identifiers";
import { readFlowCookie } from "@/lib/server/session";

export const LOGIN_FLOW = "eh_login";
export type LoginFlow = { c: string; id: Identifier; ch: "sms" | "whatsapp"; next: string };

export function readLoginFlow() {
  return readFlowCookie<LoginFlow>(LOGIN_FLOW);
}
