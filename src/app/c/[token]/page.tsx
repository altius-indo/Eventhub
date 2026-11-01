import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import en from "@/i18n/messages/en";
import hi from "@/i18n/messages/hi";
import { getMembership } from "@/lib/events";
import { resolvePassToken } from "@/lib/guest-links";
import { decide } from "@/lib/policy";
import { getSessionContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Entry pass", robots: { index: false } };

/**
 * Entry pass URL (ADR-0014). A signed-in team member who can check guests in is sent to the
 * check-in desk with this pass; anyone else sees a neutral page with no names and no cookie.
 */
export default async function PassPage({ params }: PageProps<"/c/[token]">) {
  const { token } = await params;
  const session = await getSessionContext();
  if (session) {
    const resolved = await resolvePassToken(getDb(), token);
    if (resolved) {
      const membership = await getMembership(getDb(), resolved.event.id, session.user.id);
      const subject = { isAppAdmin: session.user.isAppAdmin && !membership, membership: membership ? { role: membership.role, giftAccess: membership.giftAccess } : null };
      if (decide(subject, "checkin.operate") === "allow") redirect(`/events/${resolved.event.id}/logistics/check-in?pass=${token}`);
    }
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 text-center">
      {[en, hi].map((m, i) => (
        <section key={i} lang={i === 0 ? "en" : "hi"}>
          <h1 className="text-xl font-semibold">{m.checkin.passTitle}</h1>
          <p className="mt-2 text-muted">{m.checkin.passHelp}</p>
        </section>
      ))}
    </main>
  );
}
