import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime, type MessageKey } from "@/i18n/core";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { deliveryFailed, getThankYou, listTemplates, ThankYouError } from "@/lib/thank-yous";
import { statusTone, typeLabel } from "../../shared";
import { draftFromTemplateAction, resendAction, saveTextAction, sendOneAction, setStatusAction } from "../actions";

/** One family's thank-you: draft from a template, personalise, send or mark thanked (GFT-08/09). */
export default async function ThankYouHousehold({ params, searchParams }: PageProps<"/events/[eventId]/gifts/thank-yous/[householdId]">) {
  const { eventId, householdId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage") || !isUuid(householdId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const c = dctx(ctx);
  const data = await getThankYou(db, c, householdId).catch((e) => {
    if (e instanceof ThankYouError) notFound();
    throw e;
  });
  const templates = await listTemplates(db, c);
  const { household, row } = data;
  const status = row?.status ?? "not_started";
  const preferred = templates.find((tp) => tp.locale === household.locale) ?? templates[0];
  const base = `/events/${eventId}/gifts/thank-yous`;

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={household.name} subtitle={<Badge tone={statusTone[status]}>{t(`thankYous.statuses.${status}`)}</Badge>} />
      <Link href={base} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
        ← {t("thankYous.title")}
      </Link>
      {sp.saved === "1" && <Alert tone="success">{t("common.saved")}</Alert>}
      {sp.sent === "1" && <Alert tone="success">{t("thankYous.sentOne")}</Alert>}
      {data.itemWarning && <Alert tone="warning">{t("thankYous.itemWarning")}</Alert>}
      {status === "sent" && deliveryFailed(data.delivery?.status) && (
        <Card>
          <Alert tone="danger">{t("thankYous.deliveryFailedHelp")}</Alert>
          <SimpleForm action={resendAction.bind(null, eventId, householdId)} className="mt-3 space-y-2">
            <SubmitButton>{t("thankYous.resend")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}

      <Card>
        <CardTitle>{t("thankYous.context")}</CardTitle>
        <ul className="space-y-1 text-sm">
          {data.gifts.length === 0 && <li className="text-muted">{t("thankYous.noGiftRecorded")}</li>}
          {data.gifts.map((g) => (
            <li key={g.id}>{[typeLabel(t, g.type), g.item, g.functionName].filter(Boolean).join(" · ")}</li>
          ))}
          {data.vars.functionsAttended && <li className="text-muted">{t("thankYous.attendedList", { list: data.vars.functionsAttended })}</li>}
          {row?.sentAt && (
            <li className="text-muted">
              {t("thankYous.sentLine", { channel: row.channel ? t(`thankYous.channels.${row.channel}`) : "—", time: formatDateTime(locale, row.sentAt) })}
              {data.delivery && ` · ${t(`thankYous.delivery.${data.delivery.status}` as MessageKey)}`}
            </li>
          )}
        </ul>
      </Card>

      {templates.length > 0 && status !== "sent" && (
        <Card>
          <CardTitle>{t("thankYous.fromTemplate")}</CardTitle>
          <SimpleForm action={draftFromTemplateAction.bind(null, eventId, householdId)}>
            <Field label={t("thankYous.template")} htmlFor="ty-tpl">
              <Select id="ty-tpl" name="templateId" defaultValue={preferred?.id}>
                {templates.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name} ({t(`languages.${tp.locale as "en"}`)})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t("thankYous.personalLine")} htmlFor="ty-line" hint={t("thankYous.personalLineHelp")}>
              <Input id="ty-line" name="personalLine" maxLength={300} />
            </Field>
            <SubmitButton variant="secondary">{row?.draftText ? t("thankYous.redraft") : t("thankYous.draft")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}

      {row?.draftText && (
        <Card>
          <CardTitle>{t("thankYous.note")}</CardTitle>
          {status === "sent" ? (
            <p className="whitespace-pre-wrap text-sm">{row.draftText}</p>
          ) : (
            <>
              <SimpleForm action={saveTextAction.bind(null, eventId, householdId, row.version)}>
                <Field label={t("thankYous.note")} htmlFor="ty-text" hint={t("thankYous.noAmounts")}>
                  <Textarea id="ty-text" name="text" rows={7} maxLength={2000} defaultValue={row.draftText} />
                </Field>
                <SubmitButton variant="secondary">{t("thankYous.saveText")}</SubmitButton>
              </SimpleForm>
              {status === "drafted" && (
                <SimpleForm action={sendOneAction.bind(null, eventId, householdId, row.id)} className="mt-3 space-y-2">
                  <SubmitButton>{t("thankYous.sendNow")}</SubmitButton>
                </SimpleForm>
              )}
            </>
          )}
        </Card>
      )}

      <Card>
        <CardTitle>{t("thankYous.markTitle")}</CardTitle>
        <div className="flex flex-wrap gap-2">
          {status !== "sent" && (
            <>
              <form action={setStatusAction.bind(null, eventId, householdId, "sent", "printed")}>
                <SubmitButton variant="secondary">{t("thankYous.markPrinted")}</SubmitButton>
              </form>
              <form action={setStatusAction.bind(null, eventId, householdId, "sent", "in_person")}>
                <SubmitButton variant="secondary">{t("thankYous.markInPerson")}</SubmitButton>
              </form>
            </>
          )}
          {status !== "not_needed" && status !== "sent" && (
            <form action={setStatusAction.bind(null, eventId, householdId, "not_needed", null)}>
              <SubmitButton variant="ghost">{t("thankYous.markNotNeeded")}</SubmitButton>
            </form>
          )}
          {(status === "sent" || status === "not_needed") && (
            <form action={setStatusAction.bind(null, eventId, householdId, "not_started", null)}>
              <SubmitButton variant="ghost">{t("thankYous.reopen")}</SubmitButton>
            </form>
          )}
        </div>
      </Card>
    </div>
  );
}
