import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, PageHeader, Select } from "@/components/ui";
import { getDb } from "@/db";
import { translateDynamic } from "@/i18n/core";
import { decodeSettings, hasInviteData, ImportError, importFields, previewImport, type ImportPreview, type ImportSettings, type PreviewRow } from "@/lib/guest-import";
import type { EventFunction, RsvpStatus } from "@/db/schema";
import { formatPhone } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { commitImportAction, updateMappingAction } from "../actions";
import { isUuid } from "@/lib/ids";

const MAX_ROWS_SHOWN = 300;

export default async function ImportPreviewPage({ params, searchParams }: PageProps<"/events/[eventId]/guests/import/[importId]">) {
  const { eventId, importId } = await params;
  const { problems } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("guests.edit") || !isUuid(importId)) notFound();
  const { t, locale } = await getTranslator();

  let imp: Awaited<ReturnType<typeof previewImport>>["imp"];
  let preview: ImportPreview | null = null;
  let mappingError: string | null = null;
  let settings: ImportSettings;
  let fns: EventFunction[];
  try {
    ({ imp, preview, settings, functions: fns } = await previewImport(getDb(), eventId, importId));
  } catch (err) {
    if (!(err instanceof ImportError)) throw err;
    if (err.code === "not_found") notFound();
    mappingError = t(`importer.errors.${err.code}`);
    ({ imp, functions: fns } = await previewImport(getDb(), eventId, importId, { name: 0 }).catch(() => notFound()));
    settings = decodeSettings(imp.mapping ?? {}, fns, imp.headers.length);
  }
  const mapping = settings.mapping;
  const updateDefault = hasInviteData(settings);
  const updateChecked = settings.updateExisting ?? updateDefault;
  const fnName = new Map(fns.map((f) => [f.id, f.name]));
  const replyLabel = (s: RsvpStatus | null) => (s ? t(`rsvp.${s}`) : t("rsvp.pending"));
  const actionTone = { create: "success", update: "primary", skip: "neutral", error: "danger" } as const;
  const whatHappens = (r: PreviewRow) => {
    if (r.action === "update") {
      return r.changes.map((c) => {
        const fn = fnName.get(c.functionId) ?? "";
        if (c.newInvite) return c.to ? t("importer.changeInviteReply", { fn, to: replyLabel(c.to) }) : t("importer.changeInvite", { fn });
        return t("importer.changeReply", { fn, from: replyLabel(c.from), to: replyLabel(c.to) });
      });
    }
    if (r.action !== "create") return [];
    const reply = new Map(r.rsvps.map((a) => [a.functionId, a.status]));
    return r.functionIds.map((id) => (reply.has(id) ? `${fnName.get(id)} (${t(`rsvp.${reply.get(id)!}`)})` : (fnName.get(id) ?? "")));
  };
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
    r.issues.map((i) => translateDynamic(locale, `importer.issues.${i.code}`, { ...("value" in i ? { value: i.value } : {}), ...("row" in i ? { row: i.row } : {}), ...("name" in i ? { name: i.name } : {}), ...("column" in i ? { column: i.column } : {}) }) ?? i.code);
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
          {fns.length > 0 && (
            <div className="space-y-3 border-t border-border pt-3">
              <h3 className="font-semibold">{t("importer.functionsTitle")}</h3>
              <p className="text-sm text-muted">{t("importer.functionsHelp")}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {fns.map((fn) => (
                  <label key={fn.id} className="block space-y-1 text-sm">
                    <span className="font-medium">{t("importer.functionColumn", { name: fn.name })}</span>
                    <Select name={`fncol_${fn.id}`} defaultValue={settings.functionColumns[fn.id] ?? ""}>
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
              <fieldset>
                <legend className="mb-1 text-sm font-medium">{t("importer.inviteAll")}</legend>
                <div className="flex flex-wrap gap-x-4">
                  {fns.map((fn) => (
                    <label key={fn.id} className="inline-flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" name="inviteAll" value={fn.id} defaultChecked={settings.inviteAll.includes(fn.id)} className="h-5 w-5" />
                      {fn.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <input type="hidden" name="updateExisting_stored" value={settings.updateExisting === null ? "auto" : "set"} />
              <input type="hidden" name="updateExisting_default" value={updateDefault ? "1" : "0"} />
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <input type="checkbox" name="updateExisting" value="1" defaultChecked={updateChecked} className="mt-0.5 h-5 w-5 shrink-0" />
                <span>
                  <span className="font-medium">{t("importer.updateExisting")}</span>
                  <span className="block text-muted">{t("importer.updateExistingHelp")}</span>
                </span>
              </label>
            </div>
          )}
          <SubmitButton variant="secondary">{t("importer.updatePreview")}</SubmitButton>
        </form>
      </Card>

      {mappingError && <Alert tone="danger">{mappingError}</Alert>}

      {preview && (
        <Card>
          <CardTitle>{t("importer.previewTitle")}</CardTitle>
          <p className="mb-3 text-sm" data-testid="import-summary">
            {t("importer.summaryFull", {
              importable: preview.importable,
              households: preview.households,
              updates: preview.updates,
              rsvps: preview.rsvps,
              skipped: preview.skipped,
              errors: preview.errors,
            })}
          </p>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <SimpleForm action={commitImportAction.bind(null, eventId, importId)} className="space-y-2">
              <SubmitButton disabled={preview.importable + preview.updates === 0}>
                {preview.updates === 0
                  ? t("importer.confirm", { count: preview.importable })
                  : preview.importable === 0
                    ? t("importer.confirmUpdatesOnly", { updates: preview.updates })
                    : t("importer.confirmWithUpdates", { count: preview.importable, updates: preview.updates })}
              </SubmitButton>
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
                  <th className="py-2 pr-2 font-medium">{t("importer.whatHappens")}</th>
                  <th className="py-2 font-medium">{t("importer.status")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, MAX_ROWS_SHOWN).map((r) => {
                  const kind = r.issues.some((i) => i.kind === "error") ? "danger" : r.issues.some((i) => i.kind === "skip") ? "neutral" : r.issues.some((i) => i.kind === "warning") ? "warning" : r.issues.length ? "primary" : "success";
                  return (
                    <tr key={r.row} className="border-t border-border align-top">
                      <td className="py-2 pr-2 text-muted">{r.row}</td>
                      <td className="py-2 pr-2">{r.householdName}</td>
                      <td className="py-2 pr-2">{r.name || "—"}</td>
                      <td className="py-2 pr-2">{t(`sides.${r.side}`)}</td>
                      <td className="py-2 pr-2">{formatPhone(r.phone)}</td>
                      <td className="py-2 pr-2" data-testid="row-action" data-action={r.action}>
                        <Badge tone={actionTone[r.action]}>{t(`importer.actions.${r.action}`)}</Badge>
                        {whatHappens(r).length > 0 && (
                          <ul className="mt-1 space-y-0.5 text-xs text-muted">
                            {whatHappens(r).map((line, i) => (
                              <li key={i}>{line}</li>
                            ))}
                          </ul>
                        )}
                      </td>
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
