import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, Field, Input, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, intlLocale } from "@/i18n/core";
import { formatBytes, FULL_DOWNLOADS_PER_DAY, listAlbums, splitParts, zipItems, type AlbumSummary } from "@/lib/gallery";
import { listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { createAlbumAction } from "./actions";

/** Albums per function (GAL-01) with release state, plus full downloads (GAL-06). */
export default async function GalleryPage({ params, searchParams }: PageProps<"/events/[eventId]/gallery">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const [fns, albums, all] = await Promise.all([listFunctions(db, eventId), listAlbums(db, eventId), zipItems(db, eventId)]);
  const parts = splitParts(all);
  const size = (n: number) => formatBytes(intlLocale(locale), n);
  const base = `/events/${eventId}/gallery`;
  const byFn = new Map<string, AlbumSummary[]>();
  for (const a of albums) byFn.set(a.functionId, [...(byFn.get(a.functionId) ?? []), a]);
  const albumName = (a: AlbumSummary) => a.title || t(`gallery.albumKinds.${a.kind}`);

  return (
    <div className="space-y-5">
      <PageHeader title={t("gallery.title")} subtitle={t("gallery.intro")} />
      {sp.limit === "1" && <Alert tone="warning">{t("gallery.download.limit", { count: FULL_DOWNLOADS_PER_DAY })}</Alert>}
      {fns.length === 0 && <Alert>{t("gallery.noFunctions")}</Alert>}

      {fns.map((fn) => {
        const list = byFn.get(fn.id) ?? [];
        return (
          <Card key={fn.id} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">
                {fn.name}
                {fn.date && <span className="ms-2 text-sm font-normal text-muted">{formatDay(locale, fn.date, { day: "numeric", month: "long" })}</span>}
              </h2>
              <Link href={`${base}/qr/${fn.id}`} className="inline-flex min-h-11 items-center text-sm text-primary underline">
                {t("gallery.qr")}
              </Link>
            </div>
            {list.length === 0 ? (
              <p className="text-sm text-muted">{t("gallery.noAlbums")}</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {list.map((a) => (
                  <li key={a.id}>
                    <Link href={`${base}/albums/${a.id}`} className="flex min-h-11 gap-3 rounded-lg border border-border p-2 hover:bg-surface-muted">
                      {a.coverId ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`${base}/media/${a.coverId}/thumb`} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-md object-cover" />
                      ) : (
                        <span aria-hidden className="h-16 w-16 shrink-0 rounded-md bg-surface-muted" />
                      )}
                      <span className="min-w-0 space-y-1">
                        <span className="block truncate font-medium">{albumName(a)}</span>
                        <span className="block text-xs text-muted">{t("gallery.counts", { approved: a.approved, pending: a.pending, hidden: a.hidden })}</span>
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={a.releasedAt ? "success" : "neutral"}>{a.releasedAt ? t("gallery.released") : t("gallery.notReleased")}</Badge>
                          {a.kind !== "family" && <Badge>{t(`gallery.albumKinds.${a.kind}`)}</Badge>}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {ctx.can("gallery.upload") && (
              <details>
                <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">+ {t("gallery.newAlbum")}</summary>
                <SimpleForm action={createAlbumAction.bind(null, eventId, fn.id)} className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label={t("gallery.albumTitle")} htmlFor={`album-${fn.id}`}>
                    <Input id={`album-${fn.id}`} name="title" required maxLength={80} />
                  </Field>
                  <SubmitButton>{t("gallery.createAlbum")}</SubmitButton>
                </SimpleForm>
              </details>
            )}
          </Card>
        );
      })}

      {parts.length > 0 && (
        <Card className="space-y-2">
          <h2 className="text-lg font-semibold">{t("gallery.download.all")}</h2>
          <p className="text-sm text-muted">{t("gallery.download.help", { count: FULL_DOWNLOADS_PER_DAY })}</p>
          <ul className="flex flex-wrap gap-2">
            {parts.map((p, i) => (
              <li key={i}>
                <a href={`${base}/download?part=${i + 1}`} className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-sm hover:bg-surface-muted">
                  {t("gallery.download.part", { n: i + 1, total: parts.length, size: size(p.reduce((s, x) => s + x.originalBytes, 0)) })}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
