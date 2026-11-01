import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDateTime } from "@/i18n/core";
import { listRemovalRequests } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { decideRemovalAction } from "../actions";

/** Requests from guests to take down photos they appear in (GAL-04). */
export default async function RemovalsPage({ params }: PageProps<"/events/[eventId]/gallery/removals">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gallery.moderate")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const [open, closed] = await Promise.all([listRemovalRequests(db, eventId, "open"), listRemovalRequests(db, eventId, "closed")]);
  const base = `/events/${eventId}/gallery`;
  return (
    <div className="space-y-4">
      <PageHeader title={t("gallery.removals.title")} subtitle={t("gallery.removals.help")} />
      {open.length === 0 && <p className="text-sm text-muted">{t("gallery.removals.empty")}</p>}
      {open.map(({ request: r, family, item }) => (
        <Card key={r.id} className="flex flex-col gap-3 sm:flex-row">
          {item ? (
            <Link href={`${base}/media/${item.id}`} className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${base}/media/${item.id}/thumb`} alt={item.filename} className="h-32 w-32 rounded-md object-cover" />
            </Link>
          ) : (
            <p className="text-sm text-muted">{t("gallery.removals.gone")}</p>
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm">{t("gallery.removals.requestedBy", { family: family ?? "—" })}</p>
            <p className="text-sm text-muted">{t("gallery.removals.requestedOn", { date: formatDateTime(locale, r.createdAt) })}</p>
            {r.reason && (
              <p className="whitespace-pre-line text-sm">
                <span className="text-muted">{t("gallery.removals.reason")}:</span> {r.reason}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <SimpleForm action={decideRemovalAction.bind(null, eventId, r.id, "remove")} className="space-y-2">
                <ConfirmButton variant="danger" confirm={t("gallery.removals.removeConfirm")}>
                  {t("gallery.removals.remove")}
                </ConfirmButton>
              </SimpleForm>
              <SimpleForm action={decideRemovalAction.bind(null, eventId, r.id, "keep")} className="space-y-2">
                <SubmitButton variant="secondary">{t("gallery.removals.keep")}</SubmitButton>
              </SimpleForm>
            </div>
          </div>
        </Card>
      ))}
      {closed.length > 0 && (
        <Card>
          <h2 className="mb-2 font-semibold">{t("gallery.removals.closedTitle")}</h2>
          <ul className="divide-y divide-border text-sm">
            {closed.map(({ request: r, family }) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {family ?? "—"} · {formatDateTime(locale, r.createdAt)}
                </span>
                <Badge tone={r.status === "removed" ? "danger" : "neutral"}>{t(`gallery.removals.statuses.${r.status}`)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
