"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { Alert, Badge, Button, buttonClass, cx, inputClass } from "./ui";

export type ChatRoomMessage = {
  id: string;
  seq: number;
  authorName: string;
  authorKind: "member" | "vendor";
  mine: boolean;
  body: string;
  deleted: boolean;
  time: string;
  attachments: { id: string; filename: string }[];
};

export type ChatRoomLabels = Record<
  | "messageLabel" | "placeholder" | "send" | "attach" | "attached" | "removeAttachment" | "delete" | "deleteConfirm" | "deleted"
  | "mentionPick" | "vendorTag" | "offline" | "signedOut" | "logIn" | "readOnly" | "noMessages" | "attachHelp" | "pollingHelp",
  string
> & { errors: Record<string, string> };

const POLL_MS = 5000;

/**
 * A chat thread that polls a same-origin JSON route every 5 s while the tab is visible (ADR-0026).
 * Posting uses multipart so a file can go with the message.
 */
export function ChatRoom({
  apiUrl,
  docUrlPrefix,
  initial,
  canPost,
  people,
  labels,
  loginHref,
}: {
  apiUrl: string;
  /** Attachment download URL = prefix + document id. */
  docUrlPrefix: string;
  initial: ChatRoomMessage[];
  canPost: boolean;
  people: { id: string; name: string; vendor: boolean }[];
  labels: ChatRoomLabels;
  loginHref: string;
}) {
  const [items, setItems] = useState<ChatRoomMessage[]>(initial);
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [mentions, setMentions] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [sending, setSending] = useState(false);
  const cursor = useRef(initial.length ? initial[initial.length - 1].seq : 0);
  const from = useRef(initial.length ? initial[0].seq : 0);
  const busy = useRef(false);
  const listRef = useRef<HTMLOListElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const scrollDown = () => requestAnimationFrame(() => listRef.current?.lastElementChild?.scrollIntoView({ block: "end" }));

  const merge = useCallback((incoming: ChatRoomMessage[], deleted: string[] = []) => {
    if (incoming.length === 0 && deleted.length === 0) return;
    setItems((prev) => {
      const map = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) map.set(m.id, m);
      for (const id of deleted) {
        const m = map.get(id);
        if (m) map.set(id, { ...m, deleted: true, body: "", attachments: [] });
      }
      return [...map.values()].sort((a, b) => a.seq - b.seq);
    });
    for (const m of incoming) cursor.current = Math.max(cursor.current, m.seq);
    if (!from.current && incoming.length) from.current = incoming[0].seq;
    if (incoming.length) scrollDown();
  }, []);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      // Keep fetching while the server says there's more (e.g. after the tab was hidden a while).
      for (let page = 0; page < 20; page++) {
        const res = await fetch(`${apiUrl}?after=${cursor.current}&from=${from.current || cursor.current}`, {
          headers: { "X-EH-Poll": document.visibilityState === "visible" ? "1" : "0" },
          cache: "no-store",
          redirect: "manual",
        });
        if (res.status === 401) {
          setSignedOut(true);
          return;
        }
        if (!res.ok) {
          setOffline(true);
          return;
        }
        const data = (await res.json()) as { messages: ChatRoomMessage[]; deleted: string[]; more: boolean };
        setOffline(false);
        setSignedOut(false);
        merge(data.messages, data.deleted);
        if (!data.more) break;
      }
    } catch {
      setOffline(true);
    } finally {
      busy.current = false;
    }
  }, [apiUrl, merge]);

  useEffect(() => {
    scrollDown();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => (document.visibilityState === "visible" ? start() : stop());
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll]);

  function onBodyChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setBody(value);
    const caret = e.target.selectionStart ?? value.length;
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));
    setQuery(m ? m[2] : null);
  }

  function pick(p: { id: string; name: string }) {
    const el = textRef.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${p.name} `);
    const next = before + body.slice(caret);
    setBody(next);
    setMentions((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  }

  const matches =
    query === null ? [] : people.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    if (sending || (!body.trim() && !file)) return;
    setSending(true);
    setError(null);
    const fd = new FormData();
    fd.set("op", "post");
    fd.set("body", body);
    fd.set("mentions", mentions.filter((m) => body.includes(`@${m.name}`)).map((m) => m.id).join(","));
    if (file) fd.set("file", file);
    try {
      const res = await fetch(apiUrl, { method: "POST", body: fd, redirect: "manual" });
      if (res.status === 401) {
        setSignedOut(true);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { message?: ChatRoomMessage | null; error?: string };
      if (!res.ok) {
        setError(labels.errors[data.error ?? ""] ?? labels.errors.failed);
        return;
      }
      setBody("");
      setFile(null);
      setMentions([]);
      if (fileRef.current) fileRef.current.value = "";
      if (data.message) merge([data.message]);
      void poll();
    } catch {
      setError(labels.errors.failed);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") setQuery(null);
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
  }

  async function remove(id: string) {
    if (!window.confirm(labels.deleteConfirm)) return;
    const fd = new FormData();
    fd.set("op", "delete");
    fd.set("messageId", id);
    const res = await fetch(apiUrl, { method: "POST", body: fd, redirect: "manual" }).catch(() => null);
    if (res?.ok) merge([], [id]);
    else setError(labels.errors.failed);
  }

  return (
    <div className="space-y-3">
      {signedOut && (
        <Alert tone="warning">
          {labels.signedOut}{" "}
          <Link href={loginHref} className="underline">
            {labels.logIn}
          </Link>
        </Alert>
      )}
      {offline && !signedOut && <Alert tone="warning">{labels.offline}</Alert>}
      <ol ref={listRef} className="max-h-[60dvh] space-y-3 overflow-y-auto rounded-xl border border-border bg-surface p-3" aria-live="polite" aria-relevant="additions">
        {items.length === 0 && <li className="py-6 text-center text-sm text-muted">{labels.noMessages}</li>}
        {items.map((m) => (
          <li key={m.id} className={cx("flex", m.mine ? "justify-end" : "justify-start")}>
            <div className={cx("max-w-[85%] rounded-xl px-3 py-2", m.mine ? "bg-primary-soft" : "bg-surface-muted")}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-medium text-text">{m.authorName}</span>
                {m.authorKind === "vendor" && <Badge>{labels.vendorTag}</Badge>}
                <time dateTime={m.time}>{m.time}</time>
              </div>
              {m.deleted ? (
                <p className="mt-1 text-sm italic text-muted">{labels.deleted}</p>
              ) : (
                <>
                  {m.body && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{m.body}</p>}
                  {m.attachments.map((a) => (
                    <a key={a.id} href={`${docUrlPrefix}${a.id}`} className="mt-1 flex min-h-11 items-center break-all text-sm text-primary underline">
                      {a.filename}
                    </a>
                  ))}
                  {m.mine && canPost && (
                    <button type="button" onClick={() => void remove(m.id)} className="mt-1 min-h-11 text-xs text-danger underline">
                      {labels.delete}
                    </button>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">{labels.pollingHelp}</p>
      {canPost ? (
        <form onSubmit={send} className="space-y-2">
          <label htmlFor="chat-body" className="block text-sm font-medium">
            {labels.messageLabel}
          </label>
          <div className="relative">
            <textarea
              id="chat-body"
              ref={textRef}
              value={body}
              onChange={onBodyChange}
              onKeyDown={onKeyDown}
              maxLength={4000}
              rows={3}
              placeholder={labels.placeholder}
              className={cx(inputClass, "min-h-20 py-2")}
              aria-autocomplete="list"
              aria-controls={matches.length ? "chat-mentions" : undefined}
            />
            {matches.length > 0 && (
              <ul id="chat-mentions" aria-label={labels.mentionPick} className="absolute bottom-full left-0 z-10 mb-1 w-64 max-w-full rounded-lg border border-border bg-surface p-1 shadow-lg">
                {matches.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => pick(p)} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-muted">
                      <span className="truncate">{p.name}</span>
                      {p.vendor && <Badge>{labels.vendorTag}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className={buttonClass("secondary", "cursor-pointer focus-within:ring-2 focus-within:ring-primary")}>
              {labels.attach}
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <Button type="submit" disabled={sending || (!body.trim() && !file)}>
              {labels.send}
            </Button>
          </div>
          {file ? (
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="break-all">{labels.attached.replace("{name}", file.name)}</span>
              <button
                type="button"
                className="min-h-11 text-danger underline"
                onClick={() => {
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              >
                {labels.removeAttachment}
              </button>
            </p>
          ) : (
            <p className="text-xs text-muted">{labels.attachHelp}</p>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </form>
      ) : (
        <Alert>{labels.readOnly}</Alert>
      )}
    </div>
  );
}
