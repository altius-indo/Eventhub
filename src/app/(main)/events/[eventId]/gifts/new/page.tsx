import { notFound } from "next/navigation";
import { GiftFields } from "@/components/gift-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { listFunctions } from "@/lib/functions";
import { householdOptions } from "@/lib/gifts";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { todayIn } from "@/lib/tasks";
import { createGiftAction } from "../actions";
import { giftFieldLabels } from "../shared";

export default async function NewGiftPage({ params }: PageProps<"/events/[eventId]/gifts/new">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record")) notFound();
  const { t } = await getTranslator();
  const db = getDb();
  const [households, fns] = await Promise.all([householdOptions(db, dctx(ctx)), listFunctions(db, eventId)]);
  return (
    <div className="max-w-2xl">
      <PageHeader title={t("gifts.add")} />
      <Card>
        <SimpleForm action={createGiftAction.bind(null, eventId)}>
          <GiftFields labels={giftFieldLabels(t)} households={households} functions={fns} today={todayIn(ctx.event.timezone)} />
          <SubmitButton>{t("common.save")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
