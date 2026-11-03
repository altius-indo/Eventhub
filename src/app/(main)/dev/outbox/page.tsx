import { desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { devOutbox } from "@/db/schema";

/** Development-only view of messages "sent" by the dev delivery provider (OTP codes, invitations). */
export default async function DevOutboxPage() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_DELIVERY !== "1") notFound();
  const rows = await getDb().select().from(devOutbox).orderBy(desc(devOutbox.createdAt)).limit(50);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Dev outbox" subtitle="Messages sent by the development delivery provider. Not available in production." />
      {rows.length === 0 ? (
        <Alert>No messages yet.</Alert>
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <li key={m.id}>
              <Card>
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone="primary">{m.channel}</Badge>
                  <span className="break-all font-medium">{m.to}</span>
                  <span className="text-muted">{m.createdAt.toISOString()}</span>
                </p>
                <p className="mt-2 whitespace-pre-wrap" data-testid="outbox-body">
                  {m.body}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
