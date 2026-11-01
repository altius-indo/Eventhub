import "server-only";
import type { Identifier } from "@/lib/identifiers";
import { readFlowCookie } from "@/lib/server/session";

export const ADD_ID_FLOW = "eh_addid";
export type AddIdFlow = { c: string; id: Identifier };

export function readAddIdFlow() {
  return readFlowCookie<AddIdFlow>(ADD_ID_FLOW);
}
