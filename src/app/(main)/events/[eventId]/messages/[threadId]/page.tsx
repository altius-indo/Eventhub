import Link from "next/link";
import { notFound } from "next/navigation";
import { chatLabels } from "@/components/chat-labels";
import { ChatRoom } from "@/components/chat-room";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { ChatError, clearThreadNotifications, latestMessages, markRead, mentionCandidates, openThread, parseThreadKey, threadTitle, type ChatViewer } from "@/lib/chat";
import { MAX_DOCUMENT_MB } from "@/lib/documents";
import { withTimes } from "@/lib/server/chat-api";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function ThreadPage({ params }: PageProps<"/events/[eventId]/messages/[threadId]">) {
  const { eventId, threadId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const key = parseThreadKey(threadId);
  if (!key) notFound();
  const db = getDb();
  const viewer: ChatViewer = { kind: "member", userId: ctx.user.id, isAppAdmin: ctx.viaAdmin };
  let thread;
  try {
    thread = await openThread(db, eventId, key, viewer);
  } catch (e) {
    if (e instanceof ChatError) notFound();
    throw e;
  }
  const [messages, people, name] = await Promise.all([latestMessages(db, thread, viewer), mentionCandidates(db, thread), threadTitle(db, thread)]);
  if (messages.length) await markRead(db, thread.id, ctx.user.id, messages[messages.length - 1].seq);
  const base = `/events/${eventId}/messages`;
  await clearThreadNotifications(db, ctx.user.id, `${base}/${threadId}`);
  const help = thread.kind === "team" ? t("chat.teamHelp") : thread.kind === "vendor" ? t("chat.vendorThreadHelp") : t("chat.functionThreadHelp");

  return (
    <div className="space-y-4">
      <Link href={base} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        {t("chat.back")}
      </Link>
      <PageHeader title={thread.kind === "team" ? t("chat.team") : (name ?? "")} subtitle={help} />
      <ChatRoom
        apiUrl={`${base}/${threadId}/api`}
        docUrlPrefix={`/events/${eventId}/documents/`}
        initial={withTimes(messages, locale, ctx.event.timezone)}
        canPost={ctx.can("chat.post")}
        people={people.filter((p) => p.id !== ctx.user.id)}
        labels={chatLabels(t, MAX_DOCUMENT_MB)}
        loginHref={`/login?next=${encodeURIComponent(`${base}/${threadId}`)}`}
      />
    </div>
  );
}
