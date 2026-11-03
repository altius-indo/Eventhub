import Link from "next/link";
import { notFound } from "next/navigation";
import { GalleryUploader } from "@/components/gallery-uploader";
import { getDb } from "@/db";
import { createTranslator, formatDay, intlLocale } from "@/i18n/core";
import { decodeCursor, formatBytes, guestGalleryOverview, guestZipParts, LIMITS, listGuestMedia } from "@/lib/gallery";
import { isUuid } from "@/lib/ids";
import { ACCEPT_GUEST, guestGallery, uploaderLabels } from "@/lib/server/gallery";
import { getSiteContext, siteLocale } from "@/lib/server/site-context";
import { accentBtn, outlineBtn, siteLook } from "./site-theme";
import { Toran } from "@/components/site-ornaments";

export const metadata = { robots: { index: false } };

/**
 * The family's gallery on the wedding site (GAL-03/05/06): their invited functions' released
 * photos, their own uploads, and uploading when the family allows it. Guest link cookie only.
 */
export default async function GuestGalleryPage({ params, searchParams }: PageProps<"/[slug]/gallery">) {
  const { slug } = await params;
  const sp = await searchParams;
  const site = await getSiteContext(slug);
  if (!site) notFound();
  const g = await guestGallery(slug);
  const locale = await siteLocale(sp.lang, g?.guest.household.locale);
  const t = createTranslator(locale);
  const look = siteLook(site.website);
  const base = `/${slug}/gallery`;

  if (!g) {
    // Scanned the venue QR without the family's link on this phone (no anonymous uploads).
    return (
      <div lang={locale} style={look.style} className={`min-h-dvh ${look.wrap}`}>
      {look.ornate && <Toran />}
        <div className="mx-auto max-w-md space-y-4 px-4 py-16 text-center">
          <h1 className="text-2xl" style={{ color: "var(--accent)" }}>
            {t("gallery.site.title")}
          </h1>
          <p>{t("gallery.site.linkNeeded")}</p>
          {site.isMember && (
            <Link href={`/events/${site.event.id}/gallery`} className="underline">
              {t("gallery.title")}
            </Link>
          )}
          <p>
            <Link href={`/${slug}`} className="underline" style={{ color: "var(--accent)" }}>
              {t("gallery.site.back")}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const db = getDb();
  const overview = await guestGalleryOverview(db, g.event.id, g.viewer);
  const fnId = typeof sp.fn === "string" && isUuid(sp.fn) && g.viewer.functionIds.includes(sp.fn) ? sp.fn : null;
  const fn = fnId ? overview.find((f) => f.id === fnId) : null;
  const page = fnId ? await listGuestMedia(db, g.event.id, g.viewer, fnId, decodeCursor(sp.after), 48) : null;
  // ZIPs only with originals allowed and no watermark (S4); parts sized for one request.
  const zipParts = fnId && g.settings.guestOriginals && !g.settings.watermarkText ? await guestZipParts(db, g.event.id, g.viewer, fnId) : [];

  return (
    <div lang={locale} style={look.style} className={`min-h-dvh ${look.wrap}`}>
      {look.ornate && <Toran />}
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        <nav className="flex flex-wrap gap-3 text-sm">
          <Link href={`/${slug}`} className="inline-flex min-h-11 items-center underline">
            ← {t("gallery.site.back")}
          </Link>
          {fn && (
            <Link href={base} className="inline-flex min-h-11 items-center underline">
              {t("gallery.site.title")}
            </Link>
          )}
        </nav>
        <header>
          <h1 className="text-3xl" style={{ color: "var(--accent)" }}>
            {fn ? fn.name : t("gallery.site.title")}
          </h1>
          <p className="mt-1 opacity-80">{fn ? t("gallery.site.count", { count: fn.visible }) : t("gallery.site.intro")}</p>
        </header>

        {!fn && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {overview.map((f) => (
              <li key={f.id}>
                <Link href={`${base}?fn=${f.id}`} className={`flex min-h-11 gap-3 rounded-2xl p-3 ${look.card}`}>
                  {f.coverId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${base}/media/${f.coverId}/thumb`} alt="" loading="lazy" className="h-20 w-20 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <span aria-hidden className="h-20 w-20 shrink-0 rounded-xl bg-black/5" />
                  )}
                  <span className="min-w-0">
                    <span className="block font-semibold">{f.name}</span>
                    {f.date && <span className="block text-sm opacity-70">{formatDay(locale, f.date, { day: "numeric", month: "long" })}</span>}
                    <span className="block text-sm opacity-80">{f.visible > 0 ? t("gallery.site.count", { count: f.visible }) : t("gallery.site.notYet")}</span>
                    {f.own > 0 && <span className="block text-sm opacity-80">{t("gallery.site.yours", { count: f.own })}</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {fn && page && (
          <>
            {g.settings.guestUploads && (
              <section className={`space-y-2 rounded-2xl p-4 ${look.card}`}>
                <h2 className="font-semibold">{t("gallery.site.upload")}</h2>
                <p className="text-sm opacity-80">{t("gallery.site.uploadHelp")}</p>
                <GalleryUploader
                  endpoint={`${base}/upload`}
                  functionId={fn.id}
                  guest
                  accept={ACCEPT_GUEST}
                  maxPhotoBytes={LIMITS.photo}
                  maxVideoBytes={LIMITS.videoGuest}
                  labels={uploaderLabels(t)}
                />
              </section>
            )}
            {page.items.length === 0 ? (
              <p className="opacity-80">{t("gallery.site.notYet")}</p>
            ) : (
              <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                {page.items.map((m, i) => (
                  <li key={m.id} className="relative">
                    <Link href={`${base}/photo/${m.id}`} className="block overflow-hidden rounded-lg bg-black/5" aria-label={m.householdId === g.viewer.householdId ? m.filename : t(m.kind === "video" ? "gallery.site.videoLabel" : "gallery.site.photoLabel", { n: i + 1 })}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`${base}/media/${m.id}/thumb`} alt="" loading="lazy" decoding="async" className="aspect-square w-full object-cover" />
                      {m.kind === "video" && (
                        <span aria-hidden className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-xs text-white">
                          ▶
                        </span>
                      )}
                      {m.status !== "approved" && (
                        <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-0.5 text-center text-[11px] text-white">
                          {m.status === "hidden" ? t("gallery.site.hidden") : t("gallery.site.pending")}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              {page.next && (
                <Link href={`${base}?fn=${fn.id}&after=${page.next}`} className={outlineBtn}>
                  {t("gallery.loadMore")}
                </Link>
              )}
              {zipParts.map((p, i) => (
                <a key={i} href={`${base}/download?fn=${fn.id}&part=${i + 1}`} className={accentBtn} style={{ background: "var(--accent)" }}>
                  {zipParts.length > 1 ? t("gallery.download.part", { n: i + 1, total: zipParts.length, size: formatBytes(intlLocale(locale), p.reduce((a, x) => a + x.originalBytes, 0)) }) : t("gallery.site.downloadAll")}
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
