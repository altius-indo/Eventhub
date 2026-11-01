import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { listHotels } from "@/lib/hotels";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { listRuns } from "@/lib/transfers";
import { shareAction } from "./actions";

export default async function LogisticsHome({ params }: PageProps<"/events/[eventId]/logistics">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const db = getDb();
  const [runs, hotelRows] = await Promise.all([listRuns(db, eventId), listHotels(db, eventId)]);
  const base = `/events/${eventId}/logistics`;
  const canEdit = ctx.can("travel.edit") && ctx.can("seating.edit");
  return (
    <div className="space-y-4">
      <PageHeader title={t("logistics.title")} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardTitle action={<Link href={`${base}/transfers`} className="text-sm text-primary">→</Link>}>{t("logistics.transfers")}</CardTitle>
          <p className="text-2xl font-semibold">{runs.length}</p>
          <p className="text-sm text-muted">{t("logistics.people", { count: runs.reduce((a, r) => a + r.passengers, 0) })}</p>
        </Card>
        <Card>
          <CardTitle action={<Link href={`${base}/hotels`} className="text-sm text-primary">→</Link>}>{t("logistics.hotels")}</CardTitle>
          <p className="text-2xl font-semibold">{hotelRows.length}</p>
          <p className="text-sm text-muted">{t("logistics.people", { count: hotelRows.reduce((a, h) => a + h.guests, 0) })}</p>
        </Card>
        <Card>
          <CardTitle action={<Link href={`${base}/check-in`} className="text-sm text-primary">→</Link>}>{t("logistics.checkIn")}</CardTitle>
          <Link href={`${base}/check-in`} className="text-sm text-primary hover:underline">
            {t("checkin.chooseFunction")}
          </Link>
        </Card>
      </div>
      <Card>
        <CardTitle>{t("logistics.share")}</CardTitle>
        <p className="mb-3 text-sm text-muted">{t("logistics.shareHelp")}</p>
        <SimpleForm action={shareAction.bind(null, eventId)} className="space-y-2">
          <fieldset disabled={!canEdit} className="space-y-1">
            {(["shareTransfers", "shareRooms", "shareSeating"] as const).map((k) => (
              <label key={k} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name={k} defaultChecked={ctx.event[k]} className="h-5 w-5" /> {t(`logistics.${k}`)}
              </label>
            ))}
          </fieldset>
          {canEdit && <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>}
        </SimpleForm>
      </Card>
    </div>
  );
}
