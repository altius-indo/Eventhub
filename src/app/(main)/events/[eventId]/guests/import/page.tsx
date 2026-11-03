import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, Field, PageHeader } from "@/components/ui";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { uploadImportAction } from "./actions";

export default async function ImportPage({ params }: PageProps<"/events/[eventId]/guests/import">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("guests.edit")) notFound();
  const { t } = await getTranslator();
  return (
    <div className="max-w-xl">
      <PageHeader title={t("importer.title")} />
      <Card className="space-y-4">
        <p className="text-sm">{t("importer.help")}</p>
        <a href={`/events/${eventId}/guests/template`} className="inline-block text-sm text-primary hover:underline">
          ↓ {t("importer.template")}
        </a>
        <SimpleForm action={uploadImportAction.bind(null, eventId)}>
          <Field label={t("importer.file")} htmlFor="file">
            <input
              id="file"
              name="file"
              type="file"
              required
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-border file:bg-surface file:px-4 file:text-sm"
            />
          </Field>
          <SubmitButton>{t("importer.upload")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
