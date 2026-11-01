import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { RunFields } from "@/components/run-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatWallClock, translateDynamic } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { whatsappShareUrl } from "@/lib/guest-links";
import { formatPhone } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { runFieldLabels } from "@/lib/server/m4-labels";
import { getTranslator } from "@/lib/server/session";
import { getManifest, getRun, manifestText, runWarnings, TransferError } from "@/lib/transfers";
import { deleteRunAction, unassignAction, updateRunAction } from "../../actions";
import { isUuid } from "@/lib/ids";

export default async function RunPage({ params }: PageProps<"/events/[eventId]/logistics/transfers/[runId]">) {
  const { eventId, runId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(runId)) notFound();
  const db = getDb();
  const run = await getRun(db, eventId, runId).catch((e) => {
    if (e instanceof TransferError) notFound();
    throw e;
  });
  const manifest = await getManifest(db, eventId, runId);
  const { t, locale } = await getTranslator();
  const canEdit = ctx.can("travel.edit");
  const fmt = (d: Date) => formatWallClock(locale, d, { dateStyle: "short", timeStyle: "short" });
  const warnings = runWarnings(run, manifest);
  const base = `/events/${eventId}/logistics`;

  return (
    <div className="space-y-4">
      <Link href={`${base}/transfers`} className="text-sm text-primary hover:underline">
        ← {t("transfers.title")}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="primary">{t(`transfers.kinds.${run.kind}`)}</Badge>
        <h2 className="text-xl font-semibold">
          {run.fromPlace} → {run.toPlace}
        </h2>
        <Badge>{formatWallClock(locale, run.departsAt)}</Badge>
        <Badge tone={manifest.length > run.capacity ? "danger" : "neutral"}>{t("transfers.seats", { used: manifest.length, capacity: run.capacity })}</Badge>
      </div>
      {warnings.map((w, i) => (
        <Alert key={i} tone="warning">
          {translateDynamic(locale, `transfers.warnings.${w.code}`, "guestName" in w ? { name: w.guestName } : {})}
        </Alert>
      ))}

      <Card>
        <CardTitle
          action={
            <div className="flex flex-wrap gap-2">
              <Link href={`${base}/transfers/${runId}/print`} className={buttonClass("ghost", "min-h-10")}>
                {t("logistics.print")}
              </Link>
              {run.driverPhone && manifest.length > 0 && (
                <a href={whatsappShareUrl(run.driverPhone, manifestText(run, manifest, fmt))} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "min-h-10")}>
                  {t("transfers.shareDriver")}
                </a>
              )}
            </div>
          }
        >
          {t("transfers.manifest")}
        </CardTitle>
        {manifest.length === 0 ? (
          <p className="text-sm text-muted">{t("transfers.noPassengers")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {manifest.map((m) => {
              const at = run.kind === "pickup" ? m.travel?.arrivalAt : m.travel?.departureAt;
              const num = run.kind === "pickup" ? m.travel?.arrivalNumber : m.travel?.departureNumber;
              return (
                <li key={m.guest.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="font-medium">
                      {m.guest.name} <span className="text-sm font-normal text-muted">· {m.household.name}</span>
                    </p>
                    <p className="text-sm text-muted">{[num, at && fmt(at), formatPhone(m.contactPhone)].filter(Boolean).join(" · ")}</p>
                  </div>
                  {canEdit && (
                    <form action={unassignAction.bind(null, eventId, runId, m.guest.id)}>
                      <SubmitButton variant="ghost" className="min-h-10">
                        {t("transfers.remove")}
                      </SubmitButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {canEdit && run.kind !== "shuttle" && (
          <Link href={`${base}/arrivals?dir=${run.kind === "pickup" ? "arrival" : "departure"}&date=${run.departsAt.toISOString().slice(0, 10)}`} className="mt-3 inline-block text-sm text-primary hover:underline">
            + {t("transfers.addPassengers")}
          </Link>
        )}
      </Card>

      {canEdit && (
        <Card>
          <SimpleForm action={updateRunAction.bind(null, eventId, runId)}>
            <RunFields labels={runFieldLabels(t)} run={run} functions={await listFunctions(db, eventId)} />
            <SubmitButton>{t("common.save")}</SubmitButton>
          </SimpleForm>
          <form action={deleteRunAction.bind(null, eventId, runId)} className="mt-4 border-t border-border pt-4">
            <ConfirmButton variant="ghost" className="text-danger" confirm={t("transfers.deleteConfirm")}>
              {t("transfers.delete")}
            </ConfirmButton>
          </form>
        </Card>
      )}
    </div>
  );
}
