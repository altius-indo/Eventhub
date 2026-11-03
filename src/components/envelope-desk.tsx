"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, CardTitle, Field, Input, Select, buttonClass } from "./ui";

type Household = { id: string; name: string; members: string[] };
type GiftType = "cash" | "upi" | "cheque" | "item" | "gold" | "voucher" | "other";
type ReceivedFor = "bride" | "groom" | "couple" | "parents" | "other";
type Queued = {
  clientKey: string;
  householdId: string | null;
  giverName: string | null;
  /** Shown in the waiting list; not sent. */
  label: string;
  type: GiftType;
  amountPaise: number | null;
  itemDescription: string | null;
  envelopeNo: string | null;
  receivedFor: ReceivedFor;
  at: string;
};
type Recent = { id: string; householdName: string | null; giverName: string | null; type: GiftType; amountPaise: number | null; itemDescription: string | null; envelopeNo: string | null; createdAt: string };

export type EnvelopeLabels = Record<
  | "scan" | "stopScan" | "scanHelp" | "cameraUnavailable" | "search" | "searchButton" | "noResults" | "giver" | "unknownGiver" | "unknownName"
  | "change" | "amount" | "envelopeNo" | "type" | "item" | "receivedFor" | "save" | "saved" | "savedNext" | "pending" | "offline" | "signInAgain"
  | "logIn" | "rejected" | "duplicate" | "invalidPass" | "wrongEvent" | "somethingWrong" | "recent" | "myOpen" | "entries" | "noGiver" | "noValue" | "erased",
  string
> & { types: Record<GiftType, string>; fors: Record<ReceivedFor, string>; rejectCodes: Record<string, string> };

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResult = { kind: "ok"; data: any } | { kind: "rejected"; status: number; data: { error?: string } } | { kind: "retry"; signedOut: boolean };

const CHUNK = 50;
const QUEUE_PREFIX = "eh_envelope_queue_";
const MONEY: ReadonlySet<GiftType> = new Set(["cash", "upi", "cheque"]);

function readQueue(key: string): Queued[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Rupees typed on a phone ("2,100", "501.50") → paise; null when empty or invalid. */
function toPaise(v: string): number | null {
  const s = v.replace(/[₹,\s]/g, "");
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(s)) return null;
  const [r, p = ""] = s.split(".");
  return Number(r) * 100 + Number(p.padEnd(2, "0"));
}

/**
 * Day-of envelope entry (GFT-02): find the family (search or scan their pass), type the
 * amount and envelope number, save, next. Entries queue in localStorage with a client key
 * and sync one batch at a time, so poor connectivity never loses or doubles an envelope.
 */
export function EnvelopeDesk({ apiUrl, functionId, userId, locale, timeZone, labels }: { apiUrl: string; functionId: string; userId: string; locale: string; timeZone: string; labels: EnvelopeLabels }) {
  const [results, setResults] = useState<Household[]>([]);
  const [giver, setGiver] = useState<{ householdId: string | null; name: string } | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [type, setType] = useState<GiftType>("cash");
  const [queue, setQueue] = useState<Queued[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [open, setOpen] = useState<{ count: number; totalPaise: number } | null>(null);
  const [message, setMessage] = useState<{ tone: "danger" | "success" | "warning"; text: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  const [online, setOnline] = useState(true);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const flushing = useRef<Promise<number> | null>(null);
  // Per user and function, so a shared phone never syncs one person's envelopes under another login.
  const storageKey = `${QUEUE_PREFIX}${userId}_${functionId}`;
  const inr = (p: number) => new Intl.NumberFormat(locale === "hi" ? "hi-IN" : "en-IN", { style: "currency", currency: "INR", maximumFractionDigits: p % 100 ? 2 : 0 }).format(p / 100);
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale === "hi" ? "hi-IN" : "en-IN", { hour: "numeric", minute: "2-digit", timeZone });

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

  const refresh = useCallback(async () => {
    const r = await api({ op: "recent" });
    if (r.kind === "ok") {
      setRecent(r.data.recent);
      setOpen({ count: r.data.openCount, totalPaise: r.data.openTotalPaise });
      setSignedOut(false);
    } else if (r.kind === "retry" && r.signedOut) setSignedOut(true);
  }, [api]);

  // The queue lives in localStorage; every change re-reads it so nothing added meanwhile is lost.
  const updateQueue = useCallback(
    (fn: (q: Queued[]) => Queued[]) => {
      const next = fn(readQueue(storageKey));
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      setQueue(next);
      return next;
    },
    [storageKey],
  );

  /** Sends the queue in chunks; one flush at a time. Returns how many are still waiting. */
  const flush = useCallback((): Promise<number> => {
    if (flushing.current) return flushing.current;
    const run = (async () => {
      const snapshot = readQueue(storageKey);
      const problems: string[] = [];
      const dups: string[] = [];
      for (let k = 0; k < snapshot.length; k += CHUNK) {
        const chunk = snapshot.slice(k, k + CHUNK);
        const r = await api({ op: "record", items: chunk.map(({ label, ...rest }) => (void label, rest)) });
        if (r.kind === "retry") {
          if (r.signedOut) setSignedOut(true);
          break;
        }
        setSignedOut(false);
        let done: Set<string>;
        if (r.kind === "ok") {
          const rejected: { clientKey: string; code: string }[] = r.data.rejected ?? [];
          for (const x of rejected) {
            const q = chunk.find((c) => c.clientKey === x.clientKey);
            problems.push(`${q?.label ?? "?"}: ${labels.rejectCodes[x.code] ?? labels.somethingWrong}`);
          }
          for (const d of (r.data.duplicateEnvelopes ?? []) as { clientKey: string; envelopeNo: string }[]) dups.push(labels.duplicate.replace("{no}", d.envelopeNo));
          done = new Set([...(r.data.created ?? []), ...(r.data.existing ?? []), ...rejected.map((x) => x.clientKey)]);
        } else {
          // Refused for good (no permission, function gone): drop the chunk and say so.
          for (const q of chunk) problems.push(`${q.label}: ${labels.somethingWrong}`);
          done = new Set(chunk.map((c) => c.clientKey));
        }
        updateQueue((q) => q.filter((i) => !done.has(i.clientKey)));
      }
      if (problems.length) setMessage({ tone: "danger", text: `${labels.rejected} ${problems.join("; ")}` });
      if (dups.length) setWarnings((w) => [...dups, ...w].slice(0, 5));
      return readQueue(storageKey).length;
    })();
    flushing.current = run;
    return run.finally(() => {
      flushing.current = null;
    });
  }, [api, labels, storageKey, updateQueue]);

  useEffect(() => {
    const first = setTimeout(() => {
      setQueue(readQueue(storageKey));
      setOnline(navigator.onLine);
      flush().then(refresh);
    }, 0);
    const id = setInterval(async () => {
      setOnline(navigator.onLine);
      if (readQueue(storageKey).length) await flush();
    }, 15_000);
    const onOnline = () => {
      setOnline(true);
      flush().then((left) => {
        // Once everything has synced, the "saved on this phone" note no longer applies.
        if (left === 0) setMessage((m) => (m?.text === labels.savedNext ? null : m));
        refresh();
      });
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
  }, [flush, labels.savedNext, refresh, storageKey]);

  const pick = (h: Household) => {
    setGiver({ householdId: h.id, name: h.name });
    setUnknown(false);
    setResults([]);
    setMessage(null);
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
      pick(r.data.household);
    },
    [api, labels.invalidPass, labels.offline, labels.signInAgain, labels.wrongEvent],
  );

  async function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") ?? "");
    setMessage(null);
    const r = await api({ op: "search", q });
    if (r.kind === "ok") {
      setResults(r.data.households);
      if (r.data.households.length === 0) setMessage({ tone: "warning", text: labels.noResults });
    } else if (r.kind === "retry") {
      if (r.signedOut) setSignedOut(true);
      setMessage({ tone: "warning", text: r.signedOut ? labels.signInAgain : labels.offline });
    } else setMessage({ tone: "danger", text: labels.somethingWrong });
  }

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const unknownName = String(fd.get("unknownName") ?? "").trim();
    const g = giver ?? (unknown && unknownName ? { householdId: null, name: unknownName } : null);
    if (!g) {
      setMessage({ tone: "danger", text: labels.noGiver });
      return;
    }
    const amountPaise = toPaise(String(fd.get("amount") ?? ""));
    const itemDescription = String(fd.get("item") ?? "").trim() || null;
    if (MONEY.has(type) ? !amountPaise : !amountPaise && !itemDescription) {
      setMessage({ tone: "danger", text: labels.noValue });
      return;
    }
    const entry: Queued = {
      clientKey: newKey(),
      householdId: g.householdId,
      giverName: g.householdId ? null : g.name,
      label: g.name,
      type,
      amountPaise,
      itemDescription: MONEY.has(type) ? null : itemDescription,
      envelopeNo: String(fd.get("envelopeNo") ?? "").trim() || null,
      receivedFor: (String(fd.get("receivedFor") ?? "couple") as ReceivedFor) || "couple",
      at: new Date().toISOString(),
    };
    updateQueue((q) => [...q, entry]);
    // Next envelope: clear the giver and amount, keep type and "received for".
    setGiver(null);
    setUnknown(false);
    (form.elements.namedItem("amount") as HTMLInputElement).value = "";
    (form.elements.namedItem("envelopeNo") as HTMLInputElement).value = "";
    const itemInput = form.elements.namedItem("item") as HTMLInputElement | null;
    if (itemInput) itemInput.value = "";
    setMessage(null);
    searchRef.current?.focus();
    let left = await flush();
    if (left && readQueue(storageKey).some((i) => i.clientKey === entry.clientKey)) left = await flush();
    setMessage((m) => m ?? { tone: "success", text: left ? labels.savedNext : labels.saved });
    refresh();
  }

  // ---- Camera scanning of the check-in pass: BarcodeDetector where available, jsQR otherwise.
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

  const money = MONEY.has(type);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        {!online && queue.length === 0 && <Alert tone="warning">{labels.offline}</Alert>}
        {signedOut && (
          <Alert tone="danger">
            <p>{labels.signInAgain}</p>
            <a href="/login" target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-medium underline">
              {labels.logIn}
            </a>
          </Alert>
        )}
        {queue.length > 0 && (
          <Alert tone="warning">
            {labels.pending.replace("{count}", String(queue.length))}
            {!online && ` ${labels.offline}`}
          </Alert>
        )}
        {warnings.map((w, i) => (
          <Alert key={i} tone="warning">
            {w}
          </Alert>
        ))}

        <Card>
          <CardTitle>{labels.giver}</CardTitle>
          {giver ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-lg font-semibold">{giver.name}</p>
              <button type="button" onClick={() => setGiver(null)} className={buttonClass("ghost")}>
                {labels.change}
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {scanning ? (
                  <Button type="button" variant="secondary" onClick={stopScan}>
                    {labels.stopScan}
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" onClick={startScan}>
                    {labels.scan}
                  </Button>
                )}
                <Button type="button" variant="ghost" onClick={() => setUnknown(true)}>
                  {labels.unknownGiver}
                </Button>
              </div>
              <div className={scanning ? "mt-3" : "hidden"}>
                <video ref={videoRef} playsInline muted className="aspect-square w-full max-w-sm rounded-xl bg-black object-cover" />
                <p className="mt-2 text-sm text-muted">{labels.scanHelp}</p>
              </div>
              <form onSubmit={onSearch} className="mt-3 flex gap-2" role="search">
                <Input ref={searchRef} name="q" placeholder={labels.search} aria-label={labels.search} minLength={2} required />
                <button type="submit" className={buttonClass("secondary")}>
                  {labels.searchButton}
                </button>
              </form>
              {results.length > 0 && (
                <ul className="mt-3 divide-y divide-border">
                  {results.map((h) => (
                    <li key={h.id}>
                      <button type="button" onClick={() => pick(h)} className="flex min-h-11 w-full flex-col items-start py-2 text-left hover:text-primary">
                        <span className="font-medium">{h.name}</span>
                        <span className="text-sm text-muted">{h.members.join(", ")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>

        <Card>
          <form onSubmit={onSave} className="space-y-3">
            {unknown && !giver && (
              <Field label={labels.unknownName} htmlFor="env-unknown">
                <Input id="env-unknown" name="unknownName" maxLength={120} required autoFocus />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={labels.amount} htmlFor="env-amount">
                <Input id="env-amount" name="amount" inputMode="decimal" autoComplete="off" pattern="[0-9,₹ ]*(\.[0-9]{1,2})?" className="text-xl" required={money} />
              </Field>
              <Field label={labels.envelopeNo} htmlFor="env-no">
                <Input id="env-no" name="envelopeNo" inputMode="numeric" autoComplete="off" maxLength={20} className="text-xl" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={labels.type} htmlFor="env-type">
                <Select id="env-type" value={type} onChange={(e) => setType(e.target.value as GiftType)}>
                  {(Object.keys(labels.types) as GiftType[]).map((k) => (
                    <option key={k} value={k}>
                      {labels.types[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={labels.receivedFor} htmlFor="env-for">
                <Select id="env-for" name="receivedFor" defaultValue="couple">
                  {(Object.keys(labels.fors) as ReceivedFor[]).map((k) => (
                    <option key={k} value={k}>
                      {labels.fors[k]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {!money && (
              <Field label={labels.item} htmlFor="env-item">
                <Input id="env-item" name="item" maxLength={300} />
              </Field>
            )}
            {message && <Alert tone={message.tone}>{message.text}</Alert>}
            <Button type="submit" className="min-h-12 w-full text-base">
              {labels.save}
            </Button>
          </form>
        </Card>
      </div>

      <div className="space-y-4">
        {open && (
          <Card aria-live="polite">
            <p className="text-xs text-muted">{labels.myOpen}</p>
            <p className="text-2xl font-semibold">{inr(open.totalPaise)}</p>
            <p className="text-sm text-muted">{labels.entries.replace("{count}", String(open.count))}</p>
          </Card>
        )}
        {(queue.length > 0 || recent.length > 0) && (
          <Card>
            <CardTitle>{labels.recent}</CardTitle>
            <ul className="space-y-1 text-sm">
              {queue.map((q) => (
                <li key={q.clientKey} className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="warning">…</Badge>
                  {q.label} · {q.amountPaise ? inr(q.amountPaise) : q.itemDescription}
                  {q.envelopeNo && <span className="text-muted">#{q.envelopeNo}</span>}
                </li>
              ))}
              {recent.map((r) => (
                <li key={r.id}>
                  {time(r.createdAt)} · {r.householdName ?? (r.giverName && r.giverName !== "—" ? r.giverName : labels.erased)} · {r.amountPaise ? inr(r.amountPaise) : (r.itemDescription ?? labels.types[r.type])}
                  {r.envelopeNo && <span className="text-muted"> #{r.envelopeNo}</span>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
