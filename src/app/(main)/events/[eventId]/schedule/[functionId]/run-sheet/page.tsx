import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { RunItemFields } from "@/components/run-item-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Input, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatWallClock } from "@/i18n/core";
import { listMembers } from "@/lib/events";
import { getFunction, NotFoundError } from "@/lib/functions";
import { formatPhone } from "@/lib/guests";
import { listItems, lockedOverlaps } from "@/lib/runsheet";
import { getEventContext } from "@/lib/server/event-context";
import { runItemLabels } from "@/lib/server/m4-labels";
import { getTranslator } from "@/lib/server/session";
import { createItemAction, deleteItemAction, setStatusAction, shiftAction, updateItemAction } from "./actions";

const statusTone = { pending: "neutral", in_progress: "warning", done: "success" } as const;

export default async function RunSheetPage({ params }: PageProps<"/events/[eventId]/schedule/[functionId]/run-sheet">) {
  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!/^[0-9a-f-]{36}$/i.test(functionId)) notFound();
  const db = getDb();
  const fn = await getFunction(db, eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [rows, members] = await Promise.all([listItems(db, eventId, functionId), listMembers(db, eventId)]);
  const { t, locale } = await getTranslator();
  const canEdit = ctx.can("runsheet.edit");
  const memberOptions = members.map((m) => ({ id: m.user.id, name: m.user.name }));
  const overlaps = lockedOverlaps(rows.map((r) => r.item));
  const base = `/events/${eventId}/schedule/${functionId}/run-sheet`;
  const time = (d: Date) => formatWallClock(locale, d, { timeStyle: "short" });
  const lastEnd = rows.at(-1)?.item;
  const defaultStart = lastEnd
    ? new Date(lastEnd.startsAt.getTime() + (lastEnd.durationMin ?? 15) * 60_000).toISOString().slice(0, 16)
    : fn.date
      ? `${fn.date}T${(fn.startTime ?? "18:00").slice(0, 5)}`
      : "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <Link href={`/events/${eventId}/schedule`} className="text-sm text-primary hover:underline">
            ← {t("schedule.title")}
          </Link>
          <h2 className="text-xl font-semibold">{t("runsheet.forFunction", { name: fn.name })}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`${base}/live`} className={buttonClass("primary")}>
            {t("runsheet.live")}
          </Link>
          <Link href={`${base}/print`} className={buttonClass("secondary")}>
            {t("logistics.print")}
          </Link>
        </div>
      </div>
      {overlaps.map((o, i) => (
        <Alert key={i} tone="warning">
          {t("runsheet.overlapsLocked", { other: o.other.title, locked: o.locked.title })}
        </Alert>
      ))}

      {rows.length === 0 ? (
        <Card>
          <p className="text-muted">{t("runsheet.empty")}</p>
        </Card>
      ) : (
        <ol className="space-y-2">
          {rows.map(({ item, ownerUserName }) => (
            <li key={item.id}>
              <Card className={item.status === "done" ? "opacity-70" : undefined}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="w-24 shrink-0">
                    <p className="font-semibold tabular-nums">{time(item.startsAt)}</p>
                    {item.durationMin && <p className="text-xs text-muted">{t("runsheet.duration")}: {item.durationMin}</p>}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium">
                      {item.title}
                      <Badge tone={statusTone[item.status]}>{t(`runsheet.status.${item.status}`)}</Badge>
                      {item.timeLocked && <Badge tone="primary">🔒 {t("runsheet.locked")}</Badge>}
                    </p>
                    <p className="text-sm text-muted">
                      {[item.location, ownerUserName, item.ownerName, formatPhone(item.ownerPhone)].filter(Boolean).join(" · ")}
                    </p>
                    {item.notes && <p className="mt-1 whitespace-pre-line text-sm">{item.notes}</p>}
                  </div>
                  {canEdit && (
                    <div className="flex gap-1">
                      {item.status !== "done" && (
                        <form action={setStatusAction.bind(null, eventId, functionId, item.id, item.status === "pending" ? "in_progress" : "done")}>
                          <SubmitButton variant="secondary" className="min-h-10">
                            {item.status === "pending" ? t("runsheet.start") : t("runsheet.finish")}
                          </SubmitButton>
                        </form>
                      )}
                      {item.status === "done" && (
                        <form action={setStatusAction.bind(null, eventId, functionId, item.id, "pending")}>
                          <SubmitButton variant="ghost" className="min-h-10">
                            {t("runsheet.reset")}
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  )}
                </div>
                {canEdit && (
                  <details className="mt-2 border-t border-border pt-2">
                    <summary className="inline-flex min-h-10 cursor-pointer items-center text-sm text-primary">{t("runsheet.edit")}</summary>
                    <SimpleForm action={updateItemAction.bind(null, eventId, functionId, item.id)} className="mt-2 space-y-3">
                      <RunItemFields labels={runItemLabels(t)} item={item} members={memberOptions} idBase={`i${item.id}_`} />
                      <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
                    </SimpleForm>
                    <SimpleForm action={shiftAction.bind(null, eventId, functionId, item.id)} className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                      <label htmlFor={`shift-${item.id}`}>{t("runsheet.shift")}</label>
                      <Input id={`shift-${item.id}`} name="minutes" type="number" min={-720} max={720} defaultValue={15} className="min-h-10 w-24" />
                      <span>{t("logistics.minutes", { n: "" }).trim()}</span>
                      <SubmitButton variant="secondary" className="min-h-10">
                        {t("runsheet.shiftButton")}
                      </SubmitButton>
                    </SimpleForm>
                    <form action={deleteItemAction.bind(null, eventId, functionId, item.id)} className="mt-2">
                      <ConfirmButton variant="ghost" className="min-h-10 text-danger" confirm={t("runsheet.deleteConfirm")}>
                        {t("runsheet.delete")}
                      </ConfirmButton>
                    </form>
                  </details>
                )}
              </Card>
            </li>
          ))}
        </ol>
      )}

      {canEdit && (
        <Card>
          <CardTitle>{t("runsheet.add")}</CardTitle>
          <SimpleForm action={createItemAction.bind(null, eventId, functionId)}>
            <RunItemFields labels={runItemLabels(t)} members={memberOptions} idBase="new_" defaultStart={defaultStart} />
            <SubmitButton>{t("runsheet.add")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
