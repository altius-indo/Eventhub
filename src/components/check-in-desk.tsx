"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, CardTitle, Field, Input, Select, buttonClass } from "./ui";

type Member = { id: string; name: string; ageGroup: "adult" | "child" | "infant"; invited: boolean; rsvp: "attending" | "maybe" | "declined" | null; checkedInAt: string | null; checkedInBy: string | null };
type Household = { id: string; name: string; side: string; members: Member[] };
type Counts = { expected: number; maybe: number; noReply: number; arrived: number; arrivedExpected: number; arrivedUninvited: number; walkIns: number };
type Recent = { guestId: string; name: string; householdName: string; at: string; by: string | null };
type Queued = { guestId: string; at: string; source: "scan" | "manual"; allowUninvited: boolean };

export type DeskLabels = Record<
  | "scan" | "stopScan" | "scanHelp" | "cameraUnavailable" | "search" | "searchButton" | "noResults" | "markArrived" | "arrivedAt" | "by"
  | "notInvited" | "declined" | "undo" | "walkIn" | "walkInName" | "walkInCount" | "walkInAdd" | "expected" | "arrived" | "maybe" | "noReply"
  | "walkIns" | "uninvited" | "recent" | "pending" | "retrying" | "saved" | "allowUninvited" | "invalidPass" | "wrongEvent" | "offline"
  | "signInAgain" | "legacyPass" | "rejected" | "logIn"
  | "bride" | "groom" | "both" | "adult" | "child" | "infant" | "somethingWrong",
  string
>;

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };

/** "retry" = keep queued items and try later (offline, signed out, server error, redirected). */
type ApiResult = { kind: "ok"; data: any } | { kind: "rejected"; status: number; data: { error?: string } } | { kind: "retry"; signedOut: boolean }; // eslint-disable-line @typescript-eslint/no-explicit-any

const CHUNK = 50;
const QUEUE_PREFIX = "eh_checkin_queue_";

function readQueue(key: string): Queued[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function CheckInDesk({ apiUrl, functionId, userId, labels, initialPass }: { apiUrl: string; functionId: string; userId: string; labels: DeskLabels; initialPass?: string }) {
  const [households, setHouseholds] = useState<Household[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState<"scan" | "manual">("manual");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [queueSize, setQueueSize] = useState(0);
  const [message, setMessage] = useState<{ tone: "danger" | "success" | "warning"; text: string } | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [online, setOnline] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const flushing = useRef<Promise<number> | null>(null);
  // Per user and function, so a shared phone never syncs one person's queue under another's login.
  const storageKey = `${QUEUE_PREFIX}${userId}_${functionId}`;

  const api = useCallback(
    async (payload: object): Promise<ApiResult> => {
      let res: Response;
      try {
        res = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "manual" });
      } catch {
        return { kind: "retry", signedOut: false };
      }
      if (res.status === 401) return { kind: "retry", signedOut: true };
      if (res.redirected || res.type === "opaqueredirect" || res.status >= 500 || res.status === 0) return { kind: "retry", signedOut: false };
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        return { kind: "retry", signedOut: false };
      }
      if (res.ok) return { kind: "ok", data };
      return { kind: "rejected", status: res.status, data: (data ?? {}) as { error?: string } };
    },
    [apiUrl],
  );

  const refreshCounts = useCallback(async () => {
    const r = await api({ op: "counts" });
    if (r.kind === "ok") {
      setCounts(r.data.counts);
      setRecent(r.data.recent);
      setSignedOut(false);
    } else if (r.kind === "retry" && r.signedOut) setSignedOut(true);
  }, [api]);

  // The queue lives in localStorage (survives reloads and flaky connections); every change
  // re-reads it first so nothing appended meanwhile is lost.
  const updateQueue = useCallback(
    (fn: (q: Queued[]) => Queued[]) => {
      const next = fn(readQueue(storageKey));
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      setQueueSize(next.length);
      return next;
    },
    [storageKey],
  );

  const rollBack = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setHouseholds((hs) => hs.map((h) => ({ ...h, members: h.members.map((m) => (ids.includes(m.id) ? { ...m, checkedInAt: null } : m)) })));
  }, []);

  /** Sends the queue in chunks; only one flush runs at a time. Returns how many are still waiting. */
  const flush = useCallback((): Promise<number> => {
    if (flushing.current) return flushing.current;
    const run = (async () => {
      const snapshot = readQueue(storageKey);
      let rejectedCount = 0;
      let failed = false;
      for (const allow of [false, true]) {
        const group = snapshot.filter((i) => i.allowUninvited === allow);
        for (let k = 0; k < group.length && !failed; k += CHUNK) {
          const chunk = group.slice(k, k + CHUNK);
          const r = await api({ op: "checkin", allowUninvited: allow, items: chunk.map(({ guestId, at, source }) => ({ guestId, at, source })) });
          if (r.kind === "retry") {
            failed = true;
            if (r.signedOut) setSignedOut(true);
            break;
          }
          setSignedOut(false);
          let done: Set<string>;
          if (r.kind === "ok") {
            const rejected: { guestId: string }[] = r.data.rejected ?? [];
            rejectedCount += rejected.length;
            rollBack(rejected.map((x) => x.guestId));
            done = new Set([...(r.data.created ?? []), ...(r.data.alreadyIn ?? []), ...rejected.map((x) => x.guestId)]);
          } else {
            // Refused for good (bad input, no permission, function gone): drop the chunk.
            rejectedCount += chunk.length;
            rollBack(chunk.map((i) => i.guestId));
            done = new Set(chunk.map((i) => i.guestId));
          }
          updateQueue((q) => q.filter((i) => !(i.allowUninvited === allow && done.has(i.guestId) && chunk.some((c) => c.guestId === i.guestId && c.at === i.at))));
        }
      }
      if (rejectedCount) setMessage({ tone: "danger", text: labels.rejected.replace("{count}", String(rejectedCount)) });
      return readQueue(storageKey).length;
    })();
    flushing.current = run;
    return run.finally(() => {
      flushing.current = null;
    });
  }, [api, labels.rejected, rollBack, storageKey, updateQueue]);

  useEffect(() => {
    const first = setTimeout(() => {
      // Deferred so the first render matches the server, then shows any saved queue.
      setQueueSize(readQueue(storageKey).length);
      setOnline(navigator.onLine);
      flush().then(refreshCounts);
    }, 0);
    const id = setInterval(async () => {
      setOnline(navigator.onLine);
      if (readQueue(storageKey).length) await flush();
      await refreshCounts();
    }, 10_000);
    const onOnline = () => {
      setOnline(true);
      flush();
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [flush, refreshCounts, storageKey]);

  const show = (list: Household[], src: "scan" | "manual") => {
    setHouseholds(list);
    setSource(src);
    const sel: Record<string, boolean> = {};
    for (const h of list) for (const m of h.members) sel[m.id] = !m.checkedInAt && m.invited && m.rsvp !== "declined" && list.length === 1;
    setSelected(sel);
  };

  const lookup = useCallback(
    async (raw: string) => {
      setMessage(null);
      const r = await api({ op: "lookup", raw });
      if (r.kind === "retry") {
        if (r.signedOut) setSignedOut(true);
        setMessage({ tone: "warning", text: r.signedOut ? labels.signInAgain : labels.offline });
        return;
      }
      if (r.kind === "rejected") {
        setMessage({ tone: "danger", text: r.data.error === "wrong_event" ? labels.wrongEvent : labels.invalidPass });
        return;
      }
      show([r.data.household], "scan");
      if (r.data.legacy) setMessage({ tone: "warning", text: labels.legacyPass });
    },
    [api, labels.invalidPass, labels.legacyPass, labels.offline, labels.signInAgain, labels.wrongEvent],
  );

  useEffect(() => {
    if (!initialPass) return;
    const id = setTimeout(() => lookup(`/c/${initialPass}`), 0);
    return () => clearTimeout(id);
  }, [initialPass, lookup]);

  async function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") ?? "");
    setMessage(null);
    const r = await api({ op: "search", q });
    if (r.kind === "ok") {
      show(r.data.households, "manual");
      if (r.data.households.length === 0) setMessage({ tone: "warning", text: labels.noResults });
    } else if (r.kind === "retry") {
      if (r.signedOut) setSignedOut(true);
      setMessage({ tone: "warning", text: r.signedOut ? labels.signInAgain : labels.offline });
    } else setMessage({ tone: "danger", text: labels.somethingWrong });
  }

  async function markArrived(allowUninvited: boolean) {
    const ids = Object.entries(selected)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const items: Queued[] = ids.map((guestId) => ({ guestId, at: now, source, allowUninvited }));
    // Optimistically show them as arrived.
    setHouseholds((hs) => hs.map((h) => ({ ...h, members: h.members.map((m) => (ids.includes(m.id) ? { ...m, checkedInAt: m.checkedInAt ?? now } : m)) })));
    setSelected({});
    setMessage(null);
    updateQueue((q) => [...q.filter((i) => !ids.includes(i.guestId)), ...items]);
    let left = await flush();
    // If a flush was already running, it didn't include these; send them now.
    if (left && readQueue(storageKey).some((i) => items.some((n) => n.guestId === i.guestId && n.at === i.at))) left = await flush();
    setMessage((m) => m ?? (left ? { tone: "warning", text: labels.retrying } : { tone: "success", text: labels.saved }));
    refreshCounts();
  }

  async function undo(guestId: string) {
    // A check-in that never reached the server is just dropped from the queue.
    const wasQueued = readQueue(storageKey).some((i) => i.guestId === guestId);
    if (wasQueued) updateQueue((q) => q.filter((i) => i.guestId !== guestId));
    const r = await api({ op: "undo", guestId });
    const ok = r.kind === "ok" || (wasQueued && r.kind === "rejected" && r.data.error === "not_found");
    if (ok) {
      rollBack([guestId]);
      refreshCounts();
    } else if (r.kind === "retry") setMessage({ tone: "warning", text: r.signedOut ? labels.signInAgain : labels.offline });
    else setMessage({ tone: "danger", text: labels.somethingWrong });
  }

  async function onWalkIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const r = await api({ op: "walkin", name: String(fd.get("name")), side: String(fd.get("side")), count: Number(fd.get("count")) || 1 });
    const ok = r.kind === "ok";
    setMessage(
      ok
        ? { tone: "success", text: labels.saved }
        : r.kind === "retry"
          ? { tone: "warning", text: r.signedOut ? labels.signInAgain : labels.offline }
          : { tone: "danger", text: labels.somethingWrong },
    );
    if (ok) form.reset();
    refreshCounts();
  }

  // ---- Camera scanning: BarcodeDetector where available, jsQR otherwise (loaded on demand).
  const stopScan = useCallback(() => {
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);
  useEffect(() => stopScan, [stopScan]);

  async function startScan() {
    setMessage(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage({ tone: "warning", text: labels.cameraUnavailable });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      setScanning(true);
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const BD = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
      let detector: Detector | null = null;
      if (BD && (await BD.getSupportedFormats()).includes("qr_code")) detector = new BD({ formats: ["qr_code"] });
      const jsQR = detector ? null : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const tick = async () => {
        if (!streamRef.current) return;
        let value: string | null = null;
        if (video.readyState >= 2) {
          if (detector) {
            const found = await detector.detect(video).catch(() => []);
            value = found[0]?.rawValue ?? null;
          } else if (jsQR) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const c2d = canvas.getContext("2d", { willReadFrequently: true })!;
            c2d.drawImage(video, 0, 0);
            const img = c2d.getImageData(0, 0, canvas.width, canvas.height);
            value = jsQR(img.data, img.width, img.height)?.data ?? null;
          }
        }
        if (value) {
          stopScan();
          await lookup(value);
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      stopScan();
      setMessage({ tone: "warning", text: labels.cameraUnavailable });
    }
  }

  const anyUninvitedSelected = households.some((h) => h.members.some((m) => selected[m.id] && !m.invited));
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        {!online && <Alert tone="warning">{labels.offline}</Alert>}
        {signedOut && (
          <Alert tone="danger">
            <p>{labels.signInAgain}</p>
            <a href="/login" target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-medium underline">
              {labels.logIn}
            </a>
          </Alert>
        )}
        {queueSize > 0 && <Alert tone="warning">{labels.pending.replace("{count}", String(queueSize))}</Alert>}

        <Card>
          <div className="flex flex-wrap gap-2">
            {scanning ? (
              <Button type="button" variant="secondary" onClick={stopScan}>
                {labels.stopScan}
              </Button>
            ) : (
              <Button type="button" onClick={startScan}>
                {labels.scan}
              </Button>
            )}
          </div>
          <div className={scanning ? "mt-3" : "hidden"}>
            <video ref={videoRef} playsInline muted className="aspect-square w-full max-w-sm rounded-xl bg-black object-cover" />
            <p className="mt-2 text-sm text-muted">{labels.scanHelp}</p>
          </div>
          <form onSubmit={onSearch} className="mt-3 flex gap-2" role="search">
            <Input name="q" placeholder={labels.search} aria-label={labels.search} minLength={2} required />
            <button type="submit" className={buttonClass("secondary")}>
              {labels.searchButton}
            </button>
          </form>
        </Card>

        {message && <Alert tone={message.tone}>{message.text}</Alert>}

        {households.map((h) => (
          <Card key={h.id}>
            <CardTitle>
              {h.name} <span className="text-sm font-normal text-muted">· {labels[h.side as "bride"]}</span>
            </CardTitle>
            <ul className="divide-y divide-border">
              {h.members.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-1">
                  {m.checkedInAt ? (
                    <span aria-hidden className="flex h-11 w-11 items-center justify-center text-success">
                      ✓
                    </span>
                  ) : (
                    <label className="flex min-h-11 min-w-11 items-center justify-center">
                      <span className="sr-only">{m.name}</span>
                      <input type="checkbox" className="h-6 w-6" checked={!!selected[m.id]} onChange={(e) => setSelected({ ...selected, [m.id]: e.target.checked })} />
                    </label>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{m.name}</span>
                      {m.ageGroup !== "adult" && <Badge>{labels[m.ageGroup]}</Badge>}
                      {!m.invited && <Badge tone="warning">{labels.notInvited}</Badge>}
                      {m.rsvp === "declined" && <Badge tone="danger">{labels.declined}</Badge>}
                    </p>
                    {m.checkedInAt && (
                      <p className="text-sm text-success">
                        {labels.arrivedAt.replace("{time}", time(m.checkedInAt))}
                        {m.checkedInBy && ` · ${labels.by.replace("{name}", m.checkedInBy)}`}
                      </p>
                    )}
                  </div>
                  {m.checkedInAt && (
                    <button type="button" onClick={() => undo(m.id)} className="min-h-10 rounded-md px-2 text-sm text-muted hover:bg-surface-muted">
                      {labels.undo}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {h.members.some((m) => !m.checkedInAt) && (
              <div className="mt-3 flex flex-wrap gap-2">
                {anyUninvitedSelected ? (
                  <Button type="button" variant="secondary" onClick={() => markArrived(true)}>
                    {labels.allowUninvited}
                  </Button>
                ) : (
                  <Button type="button" className="min-h-12 px-6 text-base" onClick={() => markArrived(false)}>
                    {labels.markArrived}
                  </Button>
                )}
              </div>
            )}
          </Card>
        ))}
      </div>

      <div className="space-y-4">
        <Card aria-live="polite">
          {counts && (
            <dl className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg bg-success-soft p-2">
                <dd className="text-3xl font-semibold text-success">{counts.arrived}</dd>
                <dt className="text-xs">{labels.arrived}</dt>
              </div>
              <div className="rounded-lg bg-surface-muted p-2">
                <dd className="text-3xl font-semibold">{counts.expected}</dd>
                <dt className="text-xs">{labels.expected}</dt>
              </div>
              <div className="rounded-lg bg-surface-muted p-2">
                <dd className="text-xl font-semibold">{counts.maybe}</dd>
                <dt className="text-xs">{labels.maybe}</dt>
              </div>
              <div className="rounded-lg bg-surface-muted p-2">
                <dd className="text-xl font-semibold">{counts.noReply}</dd>
                <dt className="text-xs">{labels.noReply}</dt>
              </div>
              <div className="rounded-lg bg-surface-muted p-2">
                <dd className="text-xl font-semibold">{counts.walkIns}</dd>
                <dt className="text-xs">{labels.walkIns}</dt>
              </div>
              <div className="rounded-lg bg-surface-muted p-2">
                <dd className="text-xl font-semibold">{counts.arrivedUninvited}</dd>
                <dt className="text-xs">{labels.uninvited}</dt>
              </div>
            </dl>
          )}
        </Card>
        {recent.length > 0 && (
          <Card>
            <CardTitle>{labels.recent}</CardTitle>
            <ul className="space-y-1 text-sm">
              {recent.map((r) => (
                <li key={r.guestId}>
                  {time(r.at)} · {r.name} <span className="text-muted">· {r.householdName}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card>
          <CardTitle>{labels.walkIn}</CardTitle>
          <form onSubmit={onWalkIn} className="space-y-3">
            <Field label={labels.walkInName} htmlFor="walkin-name">
              <Input id="walkin-name" name="name" required maxLength={120} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label={labels.walkInCount} htmlFor="walkin-count">
                <Input id="walkin-count" name="count" type="number" min={1} max={20} defaultValue={1} />
              </Field>
              <Field label="&nbsp;" htmlFor="walkin-side">
                <Select id="walkin-side" name="side" defaultValue="both">
                  <option value="bride">{labels.bride}</option>
                  <option value="groom">{labels.groom}</option>
                  <option value="both">{labels.both}</option>
                </Select>
              </Field>
            </div>
            <Button type="submit" variant="secondary" className="w-full">
              {labels.walkInAdd}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
