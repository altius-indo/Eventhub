import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { GiftItemForm } from "@/components/gift-item-form";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Input, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { getGiftItem, GiftError } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { paiseToRupeesInput } from "@/lib/money";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { deleteGiftItemAction, setBoughtAction, updateGiftItemAction } from "../actions";
import { giftFormLabels, giftFormOptions, giftStatusTone } from "../shared";

export default async function EditGiftPage({ params }: PageProps<"/events/[eventId]/gifts/[itemId]">) {
  const { eventId, itemId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage") || !isUuid(itemId)) notFound();
  const { t } = await getTranslator();
  const db = getDb();
  const item = await getGiftItem(db, dctx(ctx), itemId).catch((e) => {
    if (e instanceof GiftError && e.code === "not_found") return null;
    throw e;
  });
  if (!item) notFound();
  const options = await giftFormOptions(db, dctx(ctx), t);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href={`/events/${eventId}/gifts`} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
        ← {t("gifts.back")}
      </Link>
      <PageHeader title={t("gifts.editTitle")} subtitle={item.name} action={<Badge tone={giftStatusTone[item.status]}>{t(`gifts.statuses.${item.status}`)}</Badge>} />

      <Card>
        <CardTitle>{t("gifts.fields.bought")}</CardTitle>
        <SimpleForm action={setBoughtAction.bind(null, eventId, item.id, item.version)} className="flex flex-wrap items-end gap-2">
          <Field label={item.needed === null ? t("gifts.needsFunction") : t("gifts.neededBought", { bought: item.quantityBought, needed: item.needed })} htmlFor="gift-bought">
            <Input id="gift-bought" name="bought" type="number" inputMode="numeric" min={0} max={100000} defaultValue={item.quantityBought} className="w-32" />
          </Field>
          <SubmitButton variant="secondary">{t("gifts.actions.setBought")}</SubmitButton>
        </SimpleForm>
      </Card>

      <Card>
        <GiftItemForm
          action={updateGiftItemAction.bind(null, eventId, item.id, item.version)}
          labels={giftFormLabels(t)}
          {...options}
          value={{
            name: item.name,
            description: item.description,
            category: item.category,
            functionId: item.functionId,
            giveBy: item.giveBy,
            quantityMode: item.quantityMode,
            quantityFixed: item.quantityFixed,
            quantityFunctionId: item.quantityFunctionId,
            quantityExtra: item.quantityExtra,
            forWhom: item.forWhom,
            unitCostRupees: paiseToRupeesInput(item.unitCostPaise),
            assigneeId: item.assigneeId,
            source: item.source,
            notes: item.notes,
            householdIds: item.recipients.map((r) => r.id),
          }}
        />
      </Card>

      <SimpleForm action={deleteGiftItemAction.bind(null, eventId, item.id)}>
        <ConfirmButton variant="ghost" className="text-danger" confirm={t("gifts.deleteConfirm")}>
          {t("gifts.delete")}
        </ConfirmButton>
      </SimpleForm>
    </div>
  );
}
