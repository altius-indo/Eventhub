import type { Metadata } from "next";
import en from "@/i18n/messages/en";
import hi from "@/i18n/messages/hi";
import { unsubscribeAction } from "./actions";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

/**
 * Unsubscribe link from broadcast emails (MSG-03 opt-out). Bilingual, no names or event details,
 * and the same page whether or not the token is valid. Opting out needs a button press, so link
 * scanners that open the URL don't unsubscribe anyone.
 */
export default async function UnsubscribePage({ params, searchParams }: PageProps<"/u/[token]">) {
  const { token } = await params;
  const { done } = await searchParams;
  const finished = done === "1";
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 text-center">
      {[en, hi].map((m, i) => (
        <section key={i} lang={i === 0 ? "en" : "hi"}>
          <h1 className="text-xl font-semibold">{m.unsubscribe.title}</h1>
          <p className="mt-2 text-muted">{finished ? m.unsubscribe.done : m.unsubscribe.body}</p>
        </section>
      ))}
      {!finished && (
        <form action={unsubscribeAction.bind(null, token)}>
          <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-contrast hover:bg-primary-hover">
            {en.unsubscribe.confirm} · <span lang="hi">{hi.unsubscribe.confirm}</span>
          </button>
        </form>
      )}
    </main>
  );
}
