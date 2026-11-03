import { notFound } from "next/navigation";
import { chatLabels } from "@/components/chat-labels";
import { ChatRoom } from "@/components/chat-room";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { ChatError, clearThreadNotifications, latestMessages, markRead, mentionCandidates, openThread, type ChatViewer } from "@/lib/chat";
import { MAX_DOCUMENT_MB } from "@/lib/documents";
import { withTimes } from "@/lib/server/chat-api";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

/** Vendor portal chat with the event team (VND-10, MSG-01): this vendor's thread only. */
export default async function VendorMessagesPage({ params }: PageProps<"/vendor/[vendorId]/messages">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.chat")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const viewer: ChatViewer = { kind: "vendor", userId: ctx.user.id, vendorId, isAppAdmin: ctx.viaAdmin };
  let thread;
  try {
    thread = await openThread(db, ctx.event.id, { kind: "vendor", id: vendorId }, viewer);
  } catch (e) {
    if (e instanceof ChatError) notFound();
    throw e;
  }
  const [messages, people] = await Promise.all([latestMessages(db, thread, viewer), mentionCandidates(db, thread)]);
  if (messages.length) await markRead(db, thread.id, ctx.user.id, messages[messages.length - 1].seq);
  const base = `/vendor/${vendorId}/messages`;
  await clearThreadNotifications(db, ctx.user.id, base);

  return (
    <div className="space-y-4">
      <PageHeader title={t("chat.vendorTitle", { event: ctx.event.name })} subtitle={t("chat.vendorHelp", { event: ctx.event.name })} />
      <ChatRoom
        apiUrl={`${base}/api`}
        docUrlPrefix={`${base}/api?doc=`}
        initial={withTimes(messages, locale, ctx.event.timezone)}
        canPost={!ctx.viaAdmin}
        people={people.filter((p) => p.id !== ctx.user.id)}
        labels={chatLabels(t, MAX_DOCUMENT_MB)}
        loginHref={`/login?next=${encodeURIComponent(base)}`}
      />
    </div>
  );
}
