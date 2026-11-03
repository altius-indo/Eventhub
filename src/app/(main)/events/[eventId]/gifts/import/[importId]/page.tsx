import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, PageHeader, Select } from "@/components/ui";
import { getDb } from "@/db";
import { formatInr, type MessageKey } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { getGiftImport, GiftImportError } from "@/lib/gift-import";
import { householdOptions } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { dctx } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { commitGiftImportAction, reviewGiftImportAction } from "../actions";

const MAX_ROWS_SHOWN = 300;

/** Review step (GFT-04): each row is matched to a family, kept as a free-text giver, or skipped. */
export default async function GiftImportReview({ params, searchParams }: PageProps<"/events/[eventId]/gifts/import/[importId]">) {
  const { eventId, importId } = await params;
  const { unmatched } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.manage") || !isUuid(importId)) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const c = dctx(ctx);
  const imp = await getGiftImport(db, c, importId).catch((e) => {
    if (e instanceof GiftImportError) notFound();
    throw e;
  });
  const [households, fns] = await Promise.all([householdOptions(db, c), listFunctions(db, eventId)]);
  const nameOf = new Map(households.map((h) => [h.id, h.name]));
  const fnName = new Map(fns.map((f) => [f.id, f.name]));
  const base = `/events/${eventId}/gifts`;

  if (imp.committedAt) {
    return (
      <div className="max-w-xl space-y-4">
        <PageHeader title={t("gifts.import.title")} subtitle={imp.filename} />
        <Alert tone="success">{t("gifts.import.errors.already_done")}</Alert>
        <Link href={base} className="text-primary hover:underline">
          ← {t("gifts.back")}
        </Link>
      </div>
    );
  }

  const indexed = imp.rows.map((r, i) => ({ r, i }));
  const counts = {
    match: imp.rows.filter((r) => r.decision === "match").length,
    free: imp.rows.filter((r) => r.decision === "free_text").length,
    skip: imp.rows.filter((r) => r.decision === "skip").length,
  };
  const shown = indexed.filter(({ r }) => !unmatched || r.decision !== "match").slice(0, MAX_ROWS_SHOWN);

  return (
    <div className="space-y-4">
      <PageHeader title={t("gifts.import.title")} subtitle={imp.filename} />
      <Card>
        <p className="mb-3 text-sm">{t("gifts.import.summary", { match: counts.match, free: counts.free, skip: counts.skip })}</p>
        <div className="flex flex-wrap items-center gap-3">
          <SimpleForm action={commitGiftImportAction.bind(null, eventId, importId)}>
            <SubmitButton disabled={counts.match + counts.free === 0}>{t("gifts.import.confirm", { count: counts.match + counts.free })}</SubmitButton>
          </SimpleForm>
          <Link href={unmatched ? "?" : "?unmatched=1"} className="inline-flex min-h-11 items-center text-sm text-primary hover:underline">
            {unmatched ? t("guests.clear") : t("gifts.import.onlyUnmatched")}
          </Link>
        </div>
      </Card>
      <Card>
        <CardTitle>{t("gifts.import.reviewTitle")}</CardTitle>
        <p className="mb-3 text-sm text-muted">{t("gifts.import.reviewHelp")}</p>
        <SimpleForm action={reviewGiftImportAction.bind(null, eventId, importId)}>
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-muted">
                <tr>
                  <th className="py-2 pr-2 font-medium">{t("importer.row")}</th>
                  <th className="py-2 pr-2 font-medium">{t("gifts.giverName")}</th>
                  <th className="py-2 pr-2 font-medium">{t("gifts.value")}</th>
                  <th className="py-2 pr-2 font-medium">{t("gifts.function")}</th>
                  <th className="py-2 font-medium">{t("gifts.import.decision")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(({ r, i }) => {
                  const blocked = !!r.error && r.error !== "unknown_function";
                  const current = r.decision === "match" && r.householdId ? `match:${r.householdId}` : r.decision;
                  return (
                    <tr key={i} className="border-t border-border align-top">
                      <td className="py-2 pr-2 text-muted">{i + 2}</td>
                      <td className="py-2 pr-2">
                        {r.giverName || "—"}
                        {r.envelopeNo && <span className="text-muted"> #{r.envelopeNo}</span>}
                      </td>
                      <td className="py-2 pr-2">{r.amountPaise ? formatInr(locale, r.amountPaise) : (r.item ?? "—")}</td>
                      <td className="py-2 pr-2">{r.functionId ? fnName.get(r.functionId) : "—"}</td>
                      <td className="py-2">
                        {blocked ? (
                          <Badge tone="danger">{t(`gifts.import.issues.${r.error}` as MessageKey)}</Badge>
                        ) : (
                          <>
                            <label className="sr-only" htmlFor={`row_${i}`}>
                              {t("gifts.import.decision")}
                            </label>
                            <Select id={`row_${i}`} name={`row_${i}`} defaultValue={current}>
                              {r.householdId && <option value={`match:${r.householdId}`}>{t("gifts.import.matchTo", { name: nameOf.get(r.householdId) ?? "?" })}</option>}
                              <option value="free_text">{t("gifts.import.freeText")}</option>
                              <option value="skip">{t("gifts.import.skip")}</option>
                              {r.decision !== "match" && (
                                <optgroup label={t("gifts.import.pickFamily")}>
                                  {households.map((h) => (
                                    <option key={h.id} value={`match:${h.id}`}>
                                      {h.name}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </Select>
                            {r.error === "unknown_function" && <p className="mt-1 text-xs text-warning">{t("gifts.import.issues.unknown_function")}</p>}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {indexed.length > MAX_ROWS_SHOWN && <p className="text-sm text-muted">{t("importer.showing", { count: MAX_ROWS_SHOWN })}</p>}
          <SubmitButton variant="secondary">{t("gifts.import.saveReview")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
