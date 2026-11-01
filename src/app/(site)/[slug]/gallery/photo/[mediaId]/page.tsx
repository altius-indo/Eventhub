import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Field, Input, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { createTranslator, formatDateTime } from "@/i18n/core";
import { loadMediaForViewer, reactionsFor } from "@/lib/gallery";
import { guestGallery } from "@/lib/server/gallery";
import { siteLocale } from "@/lib/server/site-context";
import { commentAction, deleteOwnAction, likeAction, removalAction } from "../../actions";
import { accentBtn, outlineBtn, siteLook } from "../../site-theme";

export const metadata = { robots: { index: false } };

/** One photo for a family: view, download, like/comment (GAL-08), ask for removal (GAL-04). */
export default async function GuestPhotoPage({ params, searchParams }: PageProps<"/[slug]/gallery/photo/[mediaId]">) {
  const { slug, mediaId } = await params;
  const sp = await searchParams;
  const g = await guestGallery(slug);
  if (!g) notFound();
  const db = getDb();
  const item = await loadMediaForViewer(db, g.event.id, mediaId, g.viewer);
  if (!item) notFound();
  const locale = await siteLocale(sp.lang, g.guest.household.locale);
  const t = createTranslator(locale);
  const look = siteLook(g.website);
  const base = `/${slug}/gallery`;
  const src = (v: string) => `${base}/media/${item.id}/${v}`;
  const own = item.householdId === g.guest.household.id;
  const reactionsOn = g.settings.reactions && item.status === "approved";
  const reactions = reactionsOn ? await reactionsFor(db, item.id, { householdId: g.guest.household.id }) : null;

  return (
    <div lang={locale} style={look.style} className={`min-h-dvh ${look.wrap}`}>
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <Link href={`${base}?fn=${item.functionId}`} className="inline-flex min-h-11 items-center text-sm underline">
          ← {t("gallery.site.backToPhotos")}
        </Link>
        <h1 className="text-xl font-semibold">{item.functionName}</h1>
        <div className="overflow-hidden rounded-2xl bg-black">
          {item.kind === "video" ? (
            <video src={src("web")} controls preload="metadata" playsInline className="mx-auto max-h-[75vh] w-full" />
          ) : item.webKey ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src("web")} alt="" className="mx-auto max-h-[75vh] w-auto object-contain" />
          ) : (
            <p className="p-6 text-center text-sm text-white">{t("gallery.site.pending")}</p>
          )}
        </div>
        <p className="text-sm opacity-70">{t("gallery.item.taken", { date: formatDateTime(locale, item.takenAt) })}</p>
        {own && item.status !== "approved" && <p className="text-sm font-medium">{item.status === "hidden" ? t("gallery.site.hidden") : t("gallery.site.pending")}</p>}

        <div className="flex flex-wrap gap-2">
          <a href={src("download")} className={accentBtn} style={{ background: "var(--accent)" }}>
            {t("gallery.site.download")}
          </a>
          {reactions && (
            <SimpleForm action={likeAction.bind(null, slug, locale, item.id)} className="space-y-1">
              <SubmitButton variant="secondary" className="rounded-full" aria-pressed={reactions.liked}>
                {reactions.liked ? `♥ ${t("gallery.site.unlike")}` : `♡ ${t("gallery.site.like")}`} · {reactions.likes}
              </SubmitButton>
            </SimpleForm>
          )}
          {own && (
            <SimpleForm action={deleteOwnAction.bind(null, slug, locale, item.id, item.functionId)}>
              <ConfirmButton variant="ghost" className="rounded-full" confirm={t("gallery.site.deleteConfirm")}>
                {t("gallery.site.deleteMine")}
              </ConfirmButton>
            </SimpleForm>
          )}
        </div>

        {reactions && (
          <section className={`space-y-3 rounded-2xl p-4 ${look.card}`}>
            <h2 className="font-semibold">{t("gallery.item.comments")}</h2>
            {reactions.comments.length === 0 && <p className="text-sm opacity-70">{t("gallery.item.noComments")}</p>}
            <ul className="space-y-2">
              {reactions.comments.map((c) => (
                <li key={c.id} className="text-sm">
                  <span className="font-medium">{c.mine ? t("gallery.site.you") : t("gallery.site.aGuest")}:</span> <span className="whitespace-pre-line">{c.body}</span>
                </li>
              ))}
            </ul>
            <SimpleForm action={commentAction.bind(null, slug, locale, item.id)} className="space-y-2">
              <Field label={t("gallery.site.comment")} htmlFor="body">
                <Input id="body" name="body" required maxLength={500} />
              </Field>
              <SubmitButton className={accentBtn} style={{ background: "var(--accent)" }}>
                {t("gallery.site.post")}
              </SubmitButton>
            </SimpleForm>
          </section>
        )}

        {!own && (
          <details className={`rounded-2xl p-4 ${look.card}`}>
            <summary className="min-h-11 cursor-pointer py-2 text-sm">{t("gallery.site.requestRemoval")}</summary>
            <p className="mb-3 text-sm opacity-80">{t("gallery.site.removalHelp")}</p>
            <SimpleForm action={removalAction.bind(null, slug, locale, item.id)} className="space-y-2">
              <Field label={t("gallery.site.removalReason")} htmlFor="reason">
                <Textarea id="reason" name="reason" rows={2} maxLength={500} />
              </Field>
              <SubmitButton variant="secondary" className={outlineBtn}>
                {t("gallery.site.requestRemoval")}
              </SubmitButton>
            </SimpleForm>
          </details>
        )}
      </div>
    </div>
  );
}
