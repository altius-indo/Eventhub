import "server-only";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import type { Thread } from "@/db/schema";
import {
  ChatError,
  deleteOwnMessage,
  discardMessage,
  latestMessages,
  markRead,
  messagesAfter,
  postMessage,
  actorOfViewer,
  type ChatMessage,
  type ChatViewer,
  type ThreadKey,
} from "../chat";
import { formatDate, type Locale } from "@/i18n/core";
import { DocumentError, getDocument, MAX_DOCUMENT_BYTES, saveDocument, sniffMime } from "../documents";

/**
 * Shared JSON endpoint for chat polling and posting (ADR-0026), used by the staff thread page and
 * the vendor portal. GET = poll (marks read only with the X-EH-Poll header, which a cross-site
 * page can't send without a CORS preflight); POST = post/delete, same-origin only.
 */

export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!origin && !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Messages for the client, with the time already formatted (no hydration differences). */
export type ClientMessage = ChatMessage & { time: string };

export function withTimes(list: ChatMessage[], locale: Locale, timeZone: string): ClientMessage[] {
  return list.map((m) => ({ ...m, time: formatDate(locale, new Date(m.createdAt), { dateStyle: "medium", timeStyle: "short", timeZone }) }));
}

type Fmt = { locale: Locale; timeZone: string };

const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });

export async function handlePoll(req: Request, thread: Thread, viewer: ChatViewer, fmt: Fmt) {
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? "0");
  const from = Number(url.searchParams.get("from") ?? String(after));
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(from) || from < 0) return json({ error: "invalid" }, 400);
  const db = getDb();
  const res = await messagesAfter(db, thread, viewer, after, Math.min(from, after));
  if (req.headers.get("x-eh-poll") === "1" && res.cursor > 0) await markRead(db, thread.id, viewer.userId, res.cursor);
  return json({ ...res, messages: withTimes(res.messages, fmt.locale, fmt.timeZone) });
}

export async function handlePost(req: Request, eventId: string, key: ThreadKey, viewer: ChatViewer, canPost: boolean, fmt: Fmt) {
  if (!sameOrigin(req)) return json({ error: "bad_origin" }, 403);
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES + 512 * 1024) return json({ error: "too_large" }, 413);
  const fd = await req.formData().catch(() => null);
  if (!fd) return json({ error: "invalid" }, 400);
  const db = getDb();
  const op = String(fd.get("op") ?? "post");
  try {
    if (op === "delete") {
      await deleteOwnMessage(db, eventId, viewer, String(fd.get("messageId") ?? ""));
      return json({ ok: true });
    }
    if (!canPost) return json({ error: "forbidden" }, 403);
    const file = fd.get("file");
    let upload: { name: string; data: Buffer } | null = null;
    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_DOCUMENT_BYTES) return json({ error: "too_large" }, 422);
      const data = Buffer.from(await file.arrayBuffer());
      if (!sniffMime(data)) return json({ error: "bad_type" }, 422);
      upload = { name: file.name, data };
    }
    const mentions = String(fd.get("mentions") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    const { message, thread } = await postMessage(db, eventId, key, viewer, { body: String(fd.get("body") ?? ""), mentions, withAttachment: !!upload });
    if (upload) {
      try {
        await saveDocument(db, eventId, actorOfViewer(viewer), { owner: { messageId: message.id }, kind: "other", filename: upload.name, data: upload.data });
      } catch (e) {
        if (!message.body) await discardMessage(db, eventId, message.id, viewer.userId);
        if (e instanceof DocumentError) return json({ error: e.code }, 422);
        throw e;
      }
    }
    const [latest] = (await latestMessages(db, thread, viewer, 1)).filter((m) => m.id === message.id);
    return json({ message: latest ? withTimes([latest], fmt.locale, fmt.timeZone)[0] : null });
  } catch (e) {
    if (e instanceof ChatError) return json({ error: e.code }, e.code === "not_found" ? 404 : 422);
    throw e;
  }
}

export async function documentResponse(eventId: string, documentId: string) {
  try {
    const { doc, data } = await getDocument(getDb(), eventId, documentId);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": doc.mime,
        "Content-Length": String(data.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof DocumentError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
