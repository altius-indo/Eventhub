import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardTitle, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import type { ThankYouTemplate } from "@/db/schema";
import { locales, type Translator } from "@/i18n/core";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { listTemplates, MERGE_FIELDS } from "@/lib/thank-yous";
import { addSuggestedTemplatesAction, deleteTemplateAction, saveTemplateAction } from "../actions";

function TemplateFields({ t, value, id }: { t: Translator; value?: ThankYouTemplate; id: string }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("thankYous.templateName")} htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} name="name" required maxLength={80} defaultValue={value?.name ?? ""} />
        </Field>
        <Field label={t("nav.language")} htmlFor={`${id}-locale`}>
          <Select id={`${id}-locale`} name="locale" defaultValue={value?.locale ?? "en"}>
            {locales.map((l) => (
              <option key={l} value={l}>
                {t(`languages.${l}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t("thankYous.body")} htmlFor={`${id}-body`} hint={t("thankYous.fieldsHelp", { fields: MERGE_FIELDS.map((f) => `{${f}}`).join(" ") })}>
        <Textarea id={`${id}-body`} name="body" required maxLength={2000} rows={6} defaultValue={value?.body ?? ""} />
      </Field>
    </>
  );
}

/** Thank-you templates per language (GFT-09). Only whitelisted merge fields; never amounts. */
export default async function TemplatesPage({ params }: PageProps<"/events/[eventId]/gifts/thank-yous/templates">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage")) notFound();
  const { t } = await getTranslator();
  const templates = await listTemplates(getDb(), dctx(ctx));
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={t("thankYous.templates")} subtitle={t("thankYous.noAmounts")} />
      <Link href={`/events/${eventId}/gifts/thank-yous`} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
        ← {t("thankYous.title")}
      </Link>
      {templates.length === 0 && (
        <form action={addSuggestedTemplatesAction.bind(null, eventId)}>
          <SubmitButton variant="secondary">{t("thankYous.addSuggested")}</SubmitButton>
        </form>
      )}
      {templates.map((tp) => (
        <Card key={tp.id}>
          <SimpleForm action={saveTemplateAction.bind(null, eventId, tp.id)}>
            <TemplateFields t={t} value={tp} id={`tpl-${tp.id}`} />
            <div className="flex flex-wrap gap-2">
              <SubmitButton>{t("common.save")}</SubmitButton>
            </div>
          </SimpleForm>
          <form action={deleteTemplateAction.bind(null, eventId, tp.id)} className="mt-2">
            <ConfirmButton variant="ghost" confirm={t("thankYous.deleteTemplateConfirm")}>
              {t("common.delete")}
            </ConfirmButton>
          </form>
        </Card>
      ))}
      <Card>
        <CardTitle>{t("thankYous.newTemplate")}</CardTitle>
        <SimpleForm action={saveTemplateAction.bind(null, eventId, null)}>
          <TemplateFields t={t} id="tpl-new" />
          <SubmitButton>{t("thankYous.addTemplate")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
