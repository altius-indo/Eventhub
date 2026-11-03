/*
 * EventHub service worker (PWA shell).
 * - Static build assets: cache-first (they are content-hashed).
 * - Day-of pages only (live run sheet, check-in desk): network-first, falling back to the last
 *   cached copy of that page, so they open at a venue with no signal (ITN-03, SEAT-04, ADR-0034).
 *   Those pages also post `cache-page` when they mount, so a visit through an in-app link counts.
 * - Every other page: network only, falling back to /offline. Other personal pages (guest lists,
 *   budgets, gifts, the guest portal) are never written to the cache.
 * The check-in desk keeps its own data (snapshot and queue) in localStorage; this worker
 * caches only the page shell. Signing out clears both.
 */
const VERSION = "v2";
const STATIC_CACHE = `eh-static-${VERSION}`;
const PAGE_CACHE = `eh-pages-${VERSION}`;
const OFFLINE_URL = "/offline";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OFFLINE_PAGES = [
  new RegExp(`^/events/${UUID}/schedule/${UUID}/run-sheet/live$`, "i"),
  new RegExp(`^/events/${UUID}/logistics/check-in/${UUID}$`, "i"),
];
const cacheable = (pathname) => OFFLINE_PAGES.some((re) => re.test(pathname));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGE_CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

// Version bump: v1 cached every page; activating v2 deletes that cache.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![STATIC_CACHE, PAGE_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  if (request.mode === "navigate") {
    const keep = cacheable(url.pathname);
    // Only the plain page is stored (a ?pass= copy would embed the pass); any query falls back to it.
    const key = url.origin + url.pathname;
    const store = keep && url.search === "";
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGE_CACHE);
        try {
          const res = await fetch(request);
          if (store && res.ok && res.type === "basic" && !res.redirected) cache.put(key, res.clone());
          return res;
        } catch {
          return (keep && (await cache.match(key))) || (await cache.match(OFFLINE_URL)) || Response.error();
        }
      })(),
    );
  }
});

/**
 * A day-of page asks to be stored (`{ type: "cache-page", path }`), because pages opened by an
 * in-app link never pass through the navigation handler above. Only the two day-of paths, with no
 * query string, from a window of this origin; the fetch carries the user's cookies, and a
 * redirect (e.g. to /login) or an error stores nothing.
 */
async function cachePage(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[?#\\]/.test(path) || !cacheable(path)) return;
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin || url.pathname !== path) return;
  const res = await fetch(url.href, { credentials: "same-origin", cache: "no-store", headers: { Accept: "text/html" } });
  if (!res.ok || res.type !== "basic" || res.redirected) return;
  const cache = await caches.open(PAGE_CACHE);
  await cache.put(url.origin + url.pathname, res);
}

// Signing out clears cached pages so the next person on a shared device can't see them.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && typeof data === "object" && data.type === "cache-page") {
    const from = event.source && "url" in event.source ? new URL(event.source.url) : null;
    if (!from || from.origin !== self.location.origin) return;
    event.waitUntil(cachePage(data.path).catch(() => undefined));
    return;
  }
  if (data === "clear-pages") {
    event.waitUntil(
      caches
        .open(PAGE_CACHE)
        .then((cache) => cache.keys().then((reqs) => Promise.all(reqs.filter((r) => new URL(r.url).pathname !== OFFLINE_URL).map((r) => cache.delete(r))))),
    );
  }
});
