import { EventForm } from "@/components/event-form";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, buttonClass, Card, CardTitle, Field, Input } from "@/components/ui";
import { getDb } from "@/db";
import { formatDate, formatDay } from "@/i18n/core";
import { ARCHIVE_DOWNLOADS_PER_DAY, listArchiveParts } from "@/lib/archive";
import { getRetention, listErasureRequests } from "@/lib/retention";
import { eventFormLabels } from "@/lib/server/event-form";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { deleteEventAction, updateEventAction, updateRsvpDeadlineAction } from "./actions";

export default async function SettingsPage({ params, searchParams }: PageProps<"/events/[eventId]/settings">) {
  const { eventId } = await params;
  const { erased, archiveLimit } = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const canEdit = ctx.can("event.update");
  const db = getDb();
  const retention = await getRetention(db, ctx.event);
  const canExport = ctx.can("event.export");
  const parts = canExport ? await listArchiveParts(db, eventId, t) : [];
  const erasures = ctx.can("guests.edit") ? await listErasureRequests(db, eventId) : [];

  return (
    <div className="max-w-xl space-y-4">
      <Card>
        <CardTitle>{t("settings.title")}</CardTitle>
        {!canEdit && (
          <div className="mb-4">
            <Alert>{t("settings.readOnly")}</Alert>
          </div>
        )}
        <EventForm
          action={updateEventAction.bind(null, eventId)}
          labels={eventFormLabels(t, t("common.save"))}
          event={ctx.event}
          disabled={!canEdit}
        />
      </Card>

      <Card>
        <CardTitle>{t("rsvp.deadline")}</CardTitle>
        <SimpleForm action={updateRsvpDeadlineAction.bind(null, eventId)} className="space-y-3">
          <Field label={t("rsvp.deadline")} htmlFor="rsvpDeadline" hint={t("rsvp.deadlineHelp")}>
            <Input id="rsvpDeadline" name="rsvpDeadline" type="date" defaultValue={ctx.event.rsvpDeadline ?? ""} disabled={!canEdit} className="sm:w-1/2" />
          </Field>
          {canEdit && <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>}
        </SimpleForm>
      </Card>

      {/* Retention, archive and erasure log (EVT-07..09) */}
      <Card>
        <h2 id="data" className="mb-3 scroll-mt-20 text-base font-semibold">
          {t("retention.dataTitle")}
        </h2>
        {erased && (
          <div className="mb-3">
            <Alert tone="success">{t("retention.erased")}</Alert>
          </div>
        )}
        <p className="text-sm text-muted">{t("retention.dataHelp")}</p>
        <p className="mt-2 text-sm font-medium">
          {retention.deletionDate
            ? t(retention.fallback ? "retention.deletionFallback" : "retention.deletionOn", { date: formatDay(locale, retention.deletionDate, { dateStyle: "long" }) })
            : t("retention.deletionNever")}
        </p>

        <h3 className="mt-5 mb-1 text-sm font-semibold">{t("retention.archiveTitle")}</h3>
        {canExport ? (
          <>
            <p className="mb-3 text-sm text-muted">{t("retention.archiveHelp")}</p>
            {archiveLimit && (
              <div className="mb-3">
                <Alert tone="warning">{t("retention.archiveLimit", { count: ARCHIVE_DOWNLOADS_PER_DAY })}</Alert>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {parts.map((p) => (
                <a key={p.id} href={`/events/${eventId}/settings/archive?part=${p.id}`} className={buttonClass(p.id === "main" ? "primary" : "secondary")}>
                  {t("retention.downloadPart", { part: p.label })}
                </a>
              ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">{t("retention.archiveHostsOnly")}</p>
        )}

        {ctx.can("guests.edit") && (
          <>
            <h3 className="mt-5 mb-1 text-sm font-semibold">{t("retention.erasureTitle")}</h3>
            <p className="mb-2 text-sm text-muted">{t("retention.erasureHelp")}</p>
            {erasures.length === 0 ? (
              <p className="text-sm text-muted">{t("retention.erasureEmpty")}</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {erasures.map(({ request: r }) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium">{r.processedAt ? t("retention.erasedFamily", { ref: r.id.slice(0, 8) }) : r.householdName}</span>
                      <span className="text-muted"> · {t("retention.erasureRequested", { date: formatDate(locale, r.requestedAt) })}</span>
                    </span>
                    {r.processedAt ? (
                      <Badge tone="success">{t("retention.erasureDone", { date: formatDate(locale, r.processedAt) })}</Badge>
                    ) : r.householdId ? (
                      <a href={`/events/${eventId}/guests/${r.householdId}`} className="text-primary underline">
                        <Badge tone="warning">{t("retention.erasurePending")}</Badge>
                      </a>
                    ) : (
                      <Badge tone="warning">{t("retention.erasurePending")}</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {ctx.can("event.delete") && (
        <Card className="border-danger/40">
          <CardTitle>{t("settings.danger")}</CardTitle>
          <p className="mb-4 text-sm text-muted">{t("settings.deleteHelp")}</p>
          <SimpleForm action={deleteEventAction.bind(null, eventId)}>
            <Field label={t("settings.deleteConfirm")} htmlFor="confirm" hint={ctx.event.name}>
              <Input id="confirm" name="confirm" autoComplete="off" required />
            </Field>
            <SubmitButton variant="danger">{t("settings.deleteButton")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
