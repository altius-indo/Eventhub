import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { GiftFields } from "@/components/gift-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardTitle, Field, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { listDocuments, MAX_DOCUMENT_MB } from "@/lib/documents";
import { listFunctions } from "@/lib/functions";
import { getGift, GiftError, giverLabel, householdOptions } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { todayIn } from "@/lib/tasks";
import { deleteGiftAction, deleteGiftPhotoAction, updateGiftAction } from "../actions";
import { giftFieldLabels, typeLabel } from "../shared";

const PHOTO_ERRORS = ["too_large", "bad_type", "quota", "invalid", "not_found"];

export default async function GiftPage({ params, searchParams }: PageProps<"/events/[eventId]/gifts/[giftId]">) {
  const { eventId, giftId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record") || !isUuid(giftId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const c = dctx(ctx);
  const gift = await getGift(db, c, giftId).catch((e) => {
    if (e instanceof GiftError) notFound();
    throw e;
  });
  const [households, fns, photos] = await Promise.all([householdOptions(db, c), listDocuments(db, eventId, { giftId }), listFunctions(db, eventId)]).then(([h, d, f]) => [h, f, d] as const);
  // Record-only collectors can't change cash that's been handed over (GFT-03).
  const locked = gift.handedOver && !ctx.can("gifts.view");
  const base = `/events/${eventId}/gifts`;
  const photoError = typeof sp.photoError === "string" && PHOTO_ERRORS.includes(sp.photoError) ? sp.photoError : null;

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={giverLabel(gift, t("gifts.erasedGiver"))} subtitle={[typeLabel(t, gift.type), gift.functionName].filter(Boolean).join(" · ")} />
      <Link href={base} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
        ← {t("gifts.back")}
      </Link>
      {sp.saved === "1" && <Alert tone="success">{t("common.saved")}</Alert>}
      {sp.dup === "1" && <Alert tone="warning">{t("gifts.duplicateEnvelope", { no: gift.envelopeNo ?? "" })}</Alert>}
      {gift.handedOver && <Alert tone={locked ? "warning" : "neutral"}>{locked ? t("gifts.lockedHandedOver") : t("gifts.editHandedOver")}</Alert>}
      <Card>
        {locked ? (
          <GiftFields labels={giftFieldLabels(t)} households={households} functions={fns} value={gift} today={todayIn(ctx.event.timezone)} />
        ) : (
          <SimpleForm action={updateGiftAction.bind(null, eventId, giftId, gift.version)}>
            <GiftFields labels={giftFieldLabels(t)} households={households} functions={fns} value={gift} today={todayIn(ctx.event.timezone)} />
            <SubmitButton>{t("common.save")}</SubmitButton>
          </SimpleForm>
        )}
        <p className="mt-3 text-xs text-muted">
          {t("gifts.recordedAt", { name: gift.recordedByName ?? t("audit.system"), time: formatDateTime(locale, gift.createdAt) })} · {t(`gifts.sources.${gift.source}`)}
        </p>
      </Card>

      <Card>
        <CardTitle>{t("gifts.photo")}</CardTitle>
        {photoError && (
          <div className="mb-3">
            <Alert tone="danger">{t(`documents.errors.${photoError as "invalid"}`, { size: MAX_DOCUMENT_MB })}</Alert>
          </div>
        )}
        {sp.photo === "ok" && (
          <div className="mb-3">
            <Alert tone="success">{t("common.saved")}</Alert>
          </div>
        )}
        {photos.length === 0 ? (
          <p className="text-sm text-muted">{t("gifts.noPhoto")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {photos.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
                <a href={`${base}/${giftId}/photo/${d.id}`} className="min-h-11 min-w-0 flex-1 break-all py-2 text-primary underline">
                  {d.filename}
                </a>
                {!locked && (
                  <form action={deleteGiftPhotoAction.bind(null, eventId, giftId, d.id)}>
                    <ConfirmButton variant="ghost" confirm={t("documents.deleteConfirm")}>
                      {t("common.remove")}
                    </ConfirmButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        {!locked && (
          <form action={`${base}/${giftId}/photo`} method="post" encType="multipart/form-data" className="mt-3 space-y-3">
            <Field label={t("gifts.photoUpload")} htmlFor="gift-photo" hint={t("gifts.photoHelp", { size: MAX_DOCUMENT_MB })}>
              <input
                id="gift-photo"
                name="file"
                type="file"
                required
                accept="image/jpeg,image/png,image/webp,image/heic"
                className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-border file:bg-surface file:px-4 file:text-sm"
              />
            </Field>
            <SubmitButton variant="secondary">{t("documents.upload")}</SubmitButton>
          </form>
        )}
      </Card>

      {!locked && (
        <SimpleForm action={deleteGiftAction.bind(null, eventId, giftId)}>
          <ConfirmButton variant="danger" confirm={t("gifts.deleteConfirm")}>
            {t("gifts.delete")}
          </ConfirmButton>
        </SimpleForm>
      )}
    </div>
  );
}
