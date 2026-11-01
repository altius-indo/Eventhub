import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import type { ServiceType } from "@/db/schema";
import type { Translator } from "@/i18n/core";
import { ensureCatalogue, listServiceTypes, templatesToLines } from "@/lib/catalogue";
import { getEventContext } from "@/lib/server/event-context";
import { typeLabel } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { addTypeAction, updateTypeAction } from "../actions";

function TypeRow({ type, t, eventId, canEdit }: { type: ServiceType; t: Translator; eventId: string; canEdit: boolean }) {
  const name = typeLabel(t, { typeKey: type.systemKey, typeName: type.name });
  return (
    <li className="py-2">
      <details>
        <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2">
          <span className="font-medium">{name}</span>
          {type.systemKey && <Badge>{t("catalogue.builtIn")}</Badge>}
          {type.requirementTemplates.length > 0 && <span className="text-sm text-muted">{type.requirementTemplates.map((x) => x.title).join(", ")}</span>}
        </summary>
        {canEdit && (
          <SimpleForm action={updateTypeAction.bind(null, eventId, type.id)} className="mt-2 space-y-3">
            {type.systemKey ? (
              <input type="hidden" name="name" value={type.name} />
            ) : (
              <Field label={t("catalogue.name")} htmlFor={`n-${type.id}`}>
                <Input id={`n-${type.id}`} name="name" required maxLength={60} defaultValue={type.name} />
              </Field>
            )}
            {type.kind === "service" && (
              <Field label={t("catalogue.templates")} htmlFor={`tp-${type.id}`} hint={t("catalogue.templatesHelp")}>
                <Textarea id={`tp-${type.id}`} name="templates" rows={4} defaultValue={templatesToLines(type.requirementTemplates)} />
              </Field>
            )}
            <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
          </SimpleForm>
        )}
      </details>
    </li>
  );
}

export default async function CataloguePage({ params }: PageProps<"/events/[eventId]/services/catalogue">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  await ensureCatalogue(getDb(), eventId, locale);
  const types = await listServiceTypes(getDb(), eventId);
  const canEdit = ctx.can("services.catalogue");
  return (
    <div className="space-y-4">
      <PageHeader title={t("catalogue.title")} subtitle={t("catalogue.help")} />
      <Card>
        <CardTitle>{t("catalogue.service")}</CardTitle>
        <ul className="divide-y divide-border">
          {types
            .filter((x) => x.kind === "service")
            .map((x) => (
              <TypeRow key={x.id} type={x} t={t} eventId={eventId} canEdit={canEdit} />
            ))}
        </ul>
      </Card>
      <Card>
        <CardTitle>{t("catalogue.standalone")}</CardTitle>
        <p className="mb-2 text-sm text-muted">{t("catalogue.standaloneHelp")}</p>
        <ul className="divide-y divide-border">
          {types
            .filter((x) => x.kind === "standalone")
            .map((x) => (
              <TypeRow key={x.id} type={x} t={t} eventId={eventId} canEdit={canEdit} />
            ))}
        </ul>
      </Card>
      {canEdit && (
        <Card>
          <CardTitle>{t("catalogue.add")}</CardTitle>
          <SimpleForm action={addTypeAction.bind(null, eventId)} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("catalogue.name")} htmlFor="new-type">
                <Input id="new-type" name="name" required maxLength={60} />
              </Field>
              <Field label={t("catalogue.kind")} htmlFor="new-kind">
                <Select id="new-kind" name="kind">
                  <option value="service">{t("catalogue.kinds.service")}</option>
                  <option value="standalone">{t("catalogue.kinds.standalone")}</option>
                </Select>
              </Field>
            </div>
            <Field label={t("catalogue.templates")} htmlFor="new-tpl" hint={t("catalogue.templatesHelp")}>
              <Textarea id="new-tpl" name="templates" rows={3} />
            </Field>
            <SubmitButton>{t("catalogue.add")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
