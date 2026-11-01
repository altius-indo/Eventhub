import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { CacheThisPage } from "@/components/offline-pages";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card } from "@/components/ui";
import { getDb } from "@/db";
import type { RunSheetItem } from "@/db/schema";
import { formatWallClock } from "@/i18n/core";
import { getFunction, NotFoundError } from "@/lib/functions";
import { liveView, listItems } from "@/lib/runsheet";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { wallClockNow } from "@/lib/wall-clock";
import { setStatusAction } from "../actions";
import { isUuid } from "@/lib/ids";

/** Day-of view (ITN-03): what's happening now, what's next, what's late. Refreshes every 30 s. */
export default async function LiveRunSheet({ params }: PageProps<"/events/[eventId]/schedule/[functionId]/run-sheet/live">) {
  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(functionId)) notFound();
  const db = getDb();
  const fn = await getFunction(db, eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const rows = await listItems(db, eventId, functionId);
  const owners = new Map(rows.map((r) => [r.item.id, [r.ownerUserName, r.ownerVendorName].filter(Boolean).join(" · ") || null]));
  const { t, locale } = await getTranslator();
  const now = wallClockNow(ctx.event.timezone);
  const view = liveView(
    rows.map((r) => r.item),
    now,
  );
  const canEdit = ctx.can("runsheet.edit");
  const time = (d: Date) => formatWallClock(locale, d, { timeStyle: "short" });

  const itemCard = (item: RunSheetItem, tone: "warning" | "danger" | "primary") => (
    <Card key={item.id} className="space-y-2">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{time(item.startsAt)}</Badge>
        <span className="text-lg font-semibold">{item.title}</span>
      </p>
      <p className="text-sm text-muted">{[item.location, owners.get(item.id), item.ownerName].filter(Boolean).join(" · ")}</p>
      {item.notes && <p className="whitespace-pre-line text-sm">{item.notes}</p>}
      <div className="flex flex-wrap gap-2">
        {item.ownerPhone && (
          <a href={`tel:${item.ownerPhone}`} className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm">
            📞 {t("runsheet.call")}
          </a>
        )}
        {canEdit && item.status !== "done" && (
          <form action={setStatusAction.bind(null, eventId, functionId, item.id, item.status === "pending" ? "in_progress" : "done")}>
            <SubmitButton className="min-h-11">{item.status === "pending" ? t("runsheet.start") : t("runsheet.finish")}</SubmitButton>
          </form>
        )}
      </div>
    </Card>
  );

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={30} />
      <CacheThisPage />
      <div>
        <Link href={`/events/${eventId}/schedule/${functionId}/run-sheet`} className="text-sm text-primary hover:underline">
          ← {t("runsheet.forFunction", { name: fn.name })}
        </Link>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{time(now)}</p>
        <p className="text-xs text-muted">{t("runsheet.updatedAuto")}</p>
      </div>
      {view.late.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-semibold text-danger">{t("runsheet.late")}</h2>
          {view.late.map((i) => itemCard(i, "danger"))}
        </section>
      )}
      <section className="space-y-2">
        <h2 className="font-semibold">{t("runsheet.now")}</h2>
        {view.current.length === 0 ? <p className="text-muted">{t("runsheet.nothingNow")}</p> : view.current.map((i) => itemCard(i, "warning"))}
      </section>
      {view.next && (
        <section className="space-y-2">
          <h2 className="font-semibold">{t("runsheet.next")}</h2>
          {itemCard(view.next, "primary")}
        </section>
      )}
    </div>
  );
}
