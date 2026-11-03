import Link from "next/link";
import { notFound } from "next/navigation";
import { BroadcastFields } from "@/components/broadcast-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { segmentOptions } from "@/lib/broadcasts";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { createDraftAction } from "../actions";

export default async function NewBroadcastPage({ params }: PageProps<"/events/[eventId]/messages/broadcasts/new">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("messaging.send")) notFound();
  const { t } = await getTranslator();
  const options = await segmentOptions(getDb(), eventId);
  return (
    <div className="space-y-4">
      <Link href={`/events/${eventId}/messages/broadcasts`} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        {t("broadcasts.title")}
      </Link>
      <PageHeader title={t("broadcasts.new")} subtitle={t("broadcasts.intro")} />
      <Card>
        <SimpleForm action={createDraftAction.bind(null, eventId)}>
          <BroadcastFields t={t} options={options} />
          <SubmitButton>{t("broadcasts.saveDraft")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
