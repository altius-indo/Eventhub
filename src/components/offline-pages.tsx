"use client";

import { useEffect } from "react";

/**
 * Day-of offline helpers (SEAT-04, ITN-03, ADR-0034).
 *
 * The service worker only stores a day-of page when the browser *navigates* to it. A page opened
 * through an in-app link (client-side navigation) or before the worker took control would never
 * be cached, so the page asks the worker to fetch and store itself. The worker re-checks that the
 * path is one of the two day-of pages and has no query string.
 */
export function cacheCurrentPage() {
  if (!("serviceWorker" in navigator)) return;
  const message = { type: "cache-page", path: location.pathname };
  const sw = navigator.serviceWorker;
  if (sw.controller) sw.controller.postMessage(message);
  else sw.ready.then((reg) => reg.active?.postMessage(message)).catch(() => undefined);
}

export const SNAPSHOT_PREFIX = "eh_checkin_snapshot_";
export const QUEUE_PREFIX = "eh_checkin_queue_";

/**
 * Removes offline copies from this device: cached day-of pages and the check-in guest-list
 * snapshots. Queued check-ins (guest ids and times only, no names) are kept unless `queues` is
 * set, so check-ins scanned while the session expired still sync after logging in again as the
 * same person (the queue key includes the user id).
 */
export function clearOfflineCopies(opts: { queues?: boolean } = {}) {
  try {
    navigator.serviceWorker?.controller?.postMessage("clear-pages");
  } catch {
    /* no service worker */
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(SNAPSHOT_PREFIX) || (opts.queues && key.startsWith(QUEUE_PREFIX))) localStorage.removeItem(key);
    }
  } catch {
    /* storage unavailable */
  }
}

/** Mount on a day-of page so it opens offline next time. */
export function CacheThisPage() {
  useEffect(() => {
    cacheCurrentPage();
  }, []);
  return null;
}

/** Mount where we know there's no session (the login page): drops offline copies. */
export function ClearOfflineCopies() {
  useEffect(() => {
    clearOfflineCopies();
  }, []);
  return null;
}
