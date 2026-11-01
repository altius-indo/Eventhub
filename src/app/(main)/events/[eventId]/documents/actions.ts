"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { deleteDocument, DocumentError } from "@/lib/documents";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";

export async function deleteDocumentAction(eventId: string, documentId: string) {
  const ctx = await getEventContext(eventId);
  if (!ctx.can("contracts.edit") || !isUuid(documentId)) return;
  await deleteDocument(getDb(), eventId, ctx.actor, documentId).catch((e) => {
    if (!(e instanceof DocumentError)) throw e;
  });
  revalidatePath(`/events/${eventId}`, "layout");
}
