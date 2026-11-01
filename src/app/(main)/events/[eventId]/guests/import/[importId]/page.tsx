import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, PageHeader, Select } from "@/components/ui";
import { getDb } from "@/db";
import { translateDynamic } from "@/i18n/core";
import { ImportError, importFields, previewImport, type ImportPreview, type PreviewRow } from "@/lib/guest-import";
import { formatPhone } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { commitImportAction, updateMappingAction } from "../actions";

const MAX_ROWS_SHOWN = 300;

export default async function ImportPreviewPage({ params, searchParams }: PageProps<"/events/[eventId]/guests/import/[importId]">) {
  const { eventId, importId } = await params;
  const { problems } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("guests.edit") || !/^[0-9a-f-]{36}$/i.test(importId)) notFound();
  const { t, locale } = await getTranslator();

  let imp: Awaited<ReturnType<typeof previewImport>>["imp"];
  let preview: ImportPreview | null = null;
  let mappingError: string | null = null;
  try {
    ({ imp, preview } = await previewImport(getDb(), eventId, importId));
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    if (err.code === "not_found") notFound();
    mappingError = t(`importer.errors.${err.code}`);
    ({ imp } = await previewImport(getDb(), eventId, importId, { name: 0 }).catch(() => notFound()));
  }
  const mapping = imp.mapping ?? {};
  const base = `/events/${eventId}/guests`;

  if (imp.completedAt) {
    return (
      <div className="max-w-xl space-y-4">
        <PageHeader title={t("importer.title")} subtitle={imp.filename} />
        <Alert tone="success">{t("importer.errors.already_done")}</Alert>
        <Link href={base} className="text-primary hover:underline">
          ← {t("household.back")}
        </Link>
      </div>
    );
  }

  const issueText = (r: PreviewRow) =>
    r.issues.map((i) => translateDynamic(locale, `importer.issues.${i.code}`, { ...("value" in i ? { value: i.value } : {}), ...("row" in i ? { row: i.row } : {}), ...("name" in i ? { name: i.name } : {}) }) ?? i.code);
  const rows = (preview?.rows ?? []).filter((r) => !problems || r.issues.length > 0);

  return (
    <div className="space-y-4">
      <PageHeader title={t("importer.title")} subtitle={imp.filename} />

      <Card>
        <CardTitle>{t("importer.mappingTitle")}</CardTitle>
        <p className="mb-3 text-sm text-muted">{t("importer.mappingHelp")}</p>
        <form action={updateMappingAction.bind(null, eventId, importId)} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {importFields.map((field) => (
              <label key={field} className="block space-y-1 text-sm">
                <span className="font-medium">{t(`importer.fields.${field}`)}</span>
                <Select name={`map_${field}`} defaultValue={mapping[field] ?? ""}>
                  <option value="">{t("importer.ignore")}</option>
                  {imp.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
          <SubmitButton variant="secondary">{t("importer.updatePreview")}</SubmitButton>
        </form>
      </Card>

      {mappingError && <Alert tone="danger">{mappingError}</Alert>}

      {preview && (
        <Card>
          <CardTitle>{t("importer.previewTitle")}</CardTitle>
          <p className="mb-3 text-sm">
            {t("importer.summary", { importable: preview.importable, households: preview.households, skipped: preview.skipped, errors: preview.errors })}
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SimpleForm action={commitImportAction.bind(null, eventId, importId)} className="space-y-2">
              <SubmitButton disabled={preview.importable === 0}>{t("importer.confirm", { count: preview.importable })}</SubmitButton>
            </SimpleForm>
            <Link href={problems ? "?" : "?problems=1"} className="text-sm text-primary hover:underline">
              {problems ? t("guests.clear") : t("importer.onlyProblems")}
            </Link>
          </div>
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-muted">
                <tr>
                  <th className="py-2 pr-2 font-medium">{t("importer.row")}</th>
                  <th className="py-2 pr-2 font-medium">{t("importer.fields.household")}</th>
                  <th className="py-2 pr-2 font-medium">{t("importer.fields.name")}</th>
                  <th className="py-2 pr-2 font-medium">{t("importer.fields.side")}</th>
                  <th className="py-2 pr-2 font-medium">{t("importer.fields.phone")}</th>
                  <th className="py-2 font-medium">{t("importer.status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, MAX_ROWS_SHOWN).map((r) => {
                  const kind = r.issues.some((i) => i.kind === "error") ? "danger" : r.issues.some((i) => i.kind === "skip") ? "neutral" : r.issues.length ? "warning" : "success";
                  return (
                    <tr key={r.row} className="border-t border-border align-top">
                      <td className="py-2 pr-2 text-muted">{r.row}</td>
                      <td className="py-2 pr-2">{r.householdName}</td>
                      <td className="py-2 pr-2">{r.name || "—"}</td>
                      <td className="py-2 pr-2">{t(`sides.${r.side}`)}</td>
                      <td className="py-2 pr-2">{formatPhone(r.phone)}</td>
                      <td className="py-2">
                        {r.issues.length === 0 ? (
                          <Badge tone="success">{t("importer.ok")}</Badge>
                        ) : (
                          <ul className="space-y-1">
                            {issueText(r).map((text, i) => (
                              <li key={i}>
                                <Badge tone={kind}>{text}</Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > MAX_ROWS_SHOWN && <p className="mt-2 text-sm text-muted">{t("importer.showing", { count: MAX_ROWS_SHOWN })}</p>}
        </Card>
      )}
    </div>
  );
}
