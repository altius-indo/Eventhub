import Link from "next/link";
import { notFound } from "next/navigation";
import { MediaGrid } from "@/components/media-grid";
import { Card, Field, PageHeader, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { GalleryError, getSelection, selectionItems } from "@/lib/gallery";
import { getTranslator } from "@/lib/server/session";
import { getVendorContext } from "@/lib/server/vendor-context";

/** The family's printed-album selection: file names and deadline (GAL-07). */
export default async function VendorSelectionPage({ params }: PageProps<"/vendor/[vendorId]/gallery/selections/[selectionId]">) {
  const { vendorId, selectionId } = await params;
  const ctx = await getVendorContext(vendorId);
  if (!ctx.can("portal.gallery") && !ctx.viaAdmin) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const s = await getSelection(db, ctx.event.id, selectionId, { vendorId }).catch((e) => {
    if (e instanceof GalleryError) notFound();
    throw e;
  });
  const items = await selectionItems(db, ctx.event.id, s.id);
  const base = `/vendor/${vendorId}/gallery`;
  return (
    <div className="space-y-4">
      <Link href={base} className="inline-flex min-h-11 items-center text-sm text-primary underline">
        ← {t("gallery.vendor.title")}
      </Link>
      <PageHeader
        title={s.title}
        subtitle={[t("gallery.selections.items", { count: items.length }), s.deadline && t("gallery.selections.deadlineOn", { date: formatDay(locale, s.deadline, { dateStyle: "long" }) })].filter(Boolean).join(" · ")}
      />
      {s.note && (
        <Card>
          <p className="whitespace-pre-line text-sm">{s.note}</p>
        </Card>
      )}
      <Card>
        <Field label={t("gallery.selections.filenames")} htmlFor="names">
          <Textarea id="names" readOnly rows={Math.min(12, Math.max(3, items.length))} value={items.map((i) => `${i.functionName}\t${i.item.filename}`).join("\n")} />
        </Field>
      </Card>
      <MediaGrid
        items={items.map(({ item }) => ({
          id: item.id,
          href: `${base}/media/${item.id}/web`,
          file: true,
          thumb: `${base}/media/${item.id}/thumb`,
          video: item.kind === "video",
          label: item.filename,
          footer: (
            <p className="truncate text-xs text-muted" title={item.filename}>
              {item.filename}
            </p>
          ),
        }))}
      />
    </div>
  );
}
