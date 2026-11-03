import type { Metadata } from "next";
import en from "@/i18n/messages/en";
import hi from "@/i18n/messages/hi";

export const metadata: Metadata = { title: "Offline" };
export const dynamic = "force-static";

/** Shown by the service worker when a page can't be loaded. Static and bilingual so it can be cached. */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 text-center">
      {[en, hi].map((m, i) => (
        <section key={i} lang={i === 0 ? "en" : "hi"}>
          <h1 className="text-xl font-semibold">{m.offline.title}</h1>
          <p className="mt-2 text-muted">{m.offline.body}</p>
        </section>
      ))}
      {/* A full page load (not client navigation) is intended here: the app shell may not be loaded. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="mx-auto inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-contrast">
        {en.offline.retry} · {hi.offline.retry}
      </a>
    </main>
  );
}
