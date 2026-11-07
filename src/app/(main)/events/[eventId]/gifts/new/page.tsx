import Link from "next/link";
import { notFound } from "next/navigation";
import { GiftItemForm } from "@/components/gift-item-form";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { createGiftItemAction } from "../actions";
import { giftFormLabels, giftFormOptions } from "../shared";

export default async function NewGiftPage({ params }: PageProps<"/events/[eventId]/gifts/new">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage")) notFound();
  const { t } = await getTranslator();
  const options = await giftFormOptions(getDb(), dctx(ctx), t);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href={`/events/${eventId}/gifts`} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
        ← {t("gifts.back")}
      </Link>
      <PageHeader title={t("gifts.newTitle")} />
      <Card>
        <GiftItemForm action={createGiftItemAction.bind(null, eventId)} labels={giftFormLabels(t)} {...options} />
      </Card>
    </div>
  );
}
