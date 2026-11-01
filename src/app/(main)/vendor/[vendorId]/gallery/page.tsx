import Link from "next/link";
import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Field, Input, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { listAlbums, listSelections, photoBookings } from "@/lib/gallery";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";
import { createVendorAlbumAction } from "./actions";

/** Deliveries per booked function and album selections shared by the family (GAL-02/07). */
export default async function VendorGalleryPage({ params }: PageProps<"/vendor/[vendorId]/gallery">) {
  const { vendorId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.gallery") && !ctx.viaAdmin) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const eventId = ctx.event.id;
  const [booked, albums, selections] = await Promise.all([photoBookings(db, eventId, { vendorId }), listAlbums(db, eventId, { vendorId }), listSelections(db, eventId, { vendorId })]);
  const fns = [...new Map(booked.map((b) => [b.functionId, b])).values()];
  const base = `/vendor/${vendorId}/gallery`;
  const canWrite = ctx.can("portal.gallery");

  return (
    <div className="space-y-5">
      <PageHeader title={t("gallery.vendor.title")} subtitle={t("gallery.vendor.intro")} />
      {fns.length === 0 && <p className="text-sm text-muted">{t("gallery.vendor.none")}</p>}
      {fns.map((fn) => (
        <Card key={fn.functionId} className="space-y-3">
          <h2 className="text-lg font-semibold">
            {fn.functionName}
            {fn.functionDate && <span className="ms-2 text-sm font-normal text-muted">{formatDay(locale, fn.functionDate, { day: "numeric", month: "long" })}</span>}
          </h2>
          <ul className="space-y-2">
            {albums
              .filter((a) => a.functionId === fn.functionId)
              .map((a) => (
                <li key={a.id}>
                  <Link href={`${base}/albums/${a.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 hover:bg-surface-muted">
                    <span className="font-medium">{a.title}</span>
                    <span className="flex items-center gap-2 text-sm text-muted">
                      {t("gallery.vendor.files", { count: a.approved + a.pending + a.hidden + a.processing })}
                      <Badge tone={a.releasedAt ? "success" : "neutral"}>{a.releasedAt ? t("gallery.released") : t("gallery.notReleased")}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
          {canWrite && (
            <SimpleForm action={createVendorAlbumAction.bind(null, vendorId, fn.functionId)} className="flex flex-wrap items-end gap-2">
              <Field label={t("gallery.vendor.newAlbum")} htmlFor={`va-${fn.functionId}`} hint={t("gallery.vendor.albumHelp")}>
                <Input id={`va-${fn.functionId}`} name="title" required maxLength={80} />
              </Field>
              <SubmitButton variant="secondary">{t("gallery.createAlbum")}</SubmitButton>
            </SimpleForm>
          )}
        </Card>
      ))}

      <Card className="space-y-2">
        <h2 className="text-lg font-semibold">{t("gallery.vendor.selections")}</h2>
        {selections.length === 0 ? (
          <p className="text-sm text-muted">{t("gallery.vendor.selectionsEmpty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {selections.map(({ selection: s, items }) => (
              <li key={s.id}>
                <Link href={`${base}/selections/${s.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 hover:underline">
                  <span className="font-medium">{s.title}</span>
                  <span className="text-sm text-muted">
                    {t("gallery.selections.items", { count: items })}
                    {s.deadline && ` · ${t("gallery.selections.deadlineOn", { date: formatDay(locale, s.deadline) })}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
