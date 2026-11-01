import Link from "next/link";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatWallClock } from "@/i18n/core";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { listRuns } from "@/lib/transfers";

export default async function TransfersPage({ params }: PageProps<"/events/[eventId]/logistics/transfers">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const runs = await listRuns(getDb(), eventId);
  const base = `/events/${eventId}/logistics/transfers`;
  return (
    <div>
      <PageHeader title={t("transfers.title")} action={ctx.can("travel.edit") && <LinkButton href={`${base}/new`}>{t("transfers.add")}</LinkButton>} />
      {runs.length === 0 ? (
        <Card>
          <p className="text-muted">{t("transfers.empty")}</p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {runs.map(({ run, passengers, functionName }) => (
            <li key={run.id}>
              <Link href={`${base}/${run.id}`} className="block rounded-xl border border-border bg-surface p-4 hover:border-primary">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge tone={run.kind === "pickup" ? "primary" : run.kind === "drop" ? "warning" : "success"}>{t(`transfers.kinds.${run.kind}`)}</Badge>
                  <span className="font-medium">{formatWallClock(locale, run.departsAt)}</span>
                  <span>
                    {run.fromPlace} → {run.toPlace}
                  </span>
                  <Badge tone={passengers > run.capacity ? "danger" : "neutral"}>{t("transfers.seats", { used: passengers, capacity: run.capacity })}</Badge>
                </p>
                <p className="mt-1 text-sm text-muted">{[run.vehicle, run.driverName, functionName].filter(Boolean).join(" · ")}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
