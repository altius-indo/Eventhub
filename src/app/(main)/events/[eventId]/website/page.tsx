import QRCode from "qrcode";
import { CopyButton } from "@/components/copy-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle, Field, Input, PageHeader, Textarea, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import type { LocalizedText, SiteContent } from "@/db/schema";
import { formatDateTime, translateDynamic, type Translator } from "@/i18n/core";
import { getEventContext } from "@/lib/server/event-context";
import { appUrl, getTranslator } from "@/lib/server/session";
import { getOrCreateWebsite, SITE_ACCENTS, SITE_THEMES } from "@/lib/website";
import { notFound } from "next/navigation";
import {
  moveSectionAction,
  publishAction,
  removeImageAction,
  saveDraftAction,
  slugAction,
  unpublishAction,
  uploadImageAction,
  visibilityAction,
} from "./actions";

type SectionKey = SiteContent["order"][number];

function Bilingual({ name, value, label, t, multiline, rows = 3 }: { name: string; value: LocalizedText; label: string; t: Translator; multiline?: boolean; rows?: number }) {
  const Control = multiline ? Textarea : Input;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {(["en", "hi"] as const).map((lang) => (
        <Field key={lang} label={`${label} · ${lang === "en" ? t("websiteEditor.english") : t("websiteEditor.hindi")}`} htmlFor={`${name}.${lang}`}>
          <Control id={`${name}.${lang}`} name={`${name}.${lang}`} defaultValue={value[lang] ?? ""} lang={lang} {...(multiline ? { rows } : {})} />
        </Field>
      ))}
    </div>
  );
}

function Photos({ ids, target, t, eventId, single }: { ids: string[]; target: "cover" | "story" | "gallery"; t: Translator; eventId: string; single?: boolean }) {
  return (
    <div className="space-y-2" id={target}>
      {ids.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {ids.map((id) => (
            <li key={id} className="space-y-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/site-images/${id}`} alt="" className="aspect-square w-full rounded-lg object-cover" />
              <button type="submit" formAction={removeImageAction.bind(null, eventId, id)} data-image-id={id} className="min-h-9 w-full rounded-md text-xs text-danger hover:bg-danger-soft">
                {t("websiteEditor.removePhoto")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(!single || ids.length === 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            name={`file.${target}`}
            accept="image/jpeg,image/png,image/webp"
            aria-label={t("websiteEditor.upload")}
            className="text-sm file:mr-2 file:min-h-10 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:text-sm"
          />
          <button type="submit" formAction={uploadImageAction.bind(null, eventId, target)} data-target={target} className={buttonClass("secondary", "min-h-10")}>
            {t("websiteEditor.upload")}
          </button>
        </div>
      )}
    </div>
  );
}

export default async function WebsiteEditorPage({ params, searchParams }: PageProps<"/events/[eventId]/website">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("website.edit")) notFound();
  const { t, locale } = await getTranslator();
  const site = await getOrCreateWebsite(getDb(), ctx.event);
  const c = site.draft;
  const url = `${appUrl()}/${site.slug}`;
  const canPublish = ctx.can("website.publish");
  const dirty = !!site.published && JSON.stringify(site.published) !== JSON.stringify(site.draft);
  const qr = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  const errorText = typeof sp.error === "string" ? translateDynamic(locale, `websiteEditor.errors.${sp.error}`) : undefined;

  const sectionBody = (key: SectionKey) => {
    const s = c.sections;
    switch (key) {
      case "welcome":
        return (
          <>
            <Bilingual name="welcome.headline" value={s.welcome.headline} label={t("websiteEditor.headline")} t={t} />
            <Bilingual name="welcome.message" value={s.welcome.message} label={t("websiteEditor.message")} t={t} multiline rows={2} />
          </>
        );
      case "story":
        return (
          <>
            <Bilingual name="story.title" value={s.story.title} label={t("websiteEditor.sectionTitle")} t={t} />
            <Bilingual name="story.body" value={s.story.body} label={t("websiteEditor.body")} t={t} multiline rows={5} />
            <p className="text-sm font-medium">{t("websiteEditor.photos")}</p>
            <Photos ids={s.story.imageIds} target="story" t={t} eventId={eventId} />
          </>
        );
      case "events":
        return (
          <>
            <Bilingual name="events.title" value={s.events.title} label={t("websiteEditor.sectionTitle")} t={t} />
            <p className="text-sm text-muted">{t("websiteEditor.eventsHelp")}</p>
          </>
        );
      case "travel":
        return (
          <>
            <Bilingual name="travel.title" value={s.travel.title} label={t("websiteEditor.sectionTitle")} t={t} />
            <Bilingual name="travel.body" value={s.travel.body} label={t("websiteEditor.body")} t={t} multiline rows={5} />
          </>
        );
      case "faqs":
        return (
          <>
            <Bilingual name="faqs.title" value={s.faqs.title} label={t("websiteEditor.sectionTitle")} t={t} />
            {[...s.faqs.items, { q: {}, a: {} }].map((item, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-dashed border-border p-3">
                {i === s.faqs.items.length && <p className="text-sm font-medium">+ {t("websiteEditor.addFaq")}</p>}
                <Bilingual name={`faq.${i}.q`} value={item.q} label={t("websiteEditor.question")} t={t} />
                <Bilingual name={`faq.${i}.a`} value={item.a} label={t("websiteEditor.answer")} t={t} multiline rows={2} />
              </div>
            ))}
          </>
        );
      case "gallery":
        return (
          <>
            <Bilingual name="gallery.title" value={s.gallery.title} label={t("websiteEditor.sectionTitle")} t={t} />
            <Photos ids={s.gallery.imageIds} target="gallery" t={t} eventId={eventId} />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="gallery.highlights" defaultChecked={!!s.gallery.highlights} className="h-5 w-5" /> {t("websiteEditor.galleryHighlights")}
            </label>
          </>
        );
      case "gifts":
        return (
          <>
            <Bilingual name="gifts.title" value={s.gifts.title} label={t("websiteEditor.sectionTitle")} t={t} />
            <Bilingual name="gifts.body" value={s.gifts.body} label={t("websiteEditor.body")} t={t} multiline rows={2} />
          </>
        );
      case "contact":
        return (
          <>
            <Bilingual name="contact.title" value={s.contact.title} label={t("websiteEditor.sectionTitle")} t={t} />
            {[...s.contact.people, { name: "", phone: "" }].map((p, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-2">
                <Field label={`${t("websiteEditor.contactName")}${i === s.contact.people.length ? ` (+ ${t("websiteEditor.addContact")})` : ""}`} htmlFor={`contact.${i}.name`}>
                  <Input id={`contact.${i}.name`} name={`contact.${i}.name`} defaultValue={p.name} maxLength={80} />
                </Field>
                <Field label={t("websiteEditor.contactPhone")} htmlFor={`contact.${i}.phone`}>
                  <Input id={`contact.${i}.phone`} name={`contact.${i}.phone`} defaultValue={p.phone} type="tel" maxLength={30} />
                </Field>
              </div>
            ))}
          </>
        );
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t("websiteEditor.title")} />
      {sp.saved && <Alert tone="success">{t("websiteEditor.draftSaved")}</Alert>}
      {sp.published && <Alert tone="success">{t("websiteEditor.published", { date: formatDateTime(locale, new Date()) })}</Alert>}
      {errorText && <Alert tone="danger">{errorText}</Alert>}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardTitle>{t("websiteEditor.status")}</CardTitle>
          <p className="mb-1 break-all font-mono text-sm" data-testid="site-url">
            {url}
          </p>
          <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {site.publishedAt ? (
              <Badge tone="success">{t("websiteEditor.published", { date: formatDateTime(locale, site.publishedAt) })}</Badge>
            ) : (
              <Badge>{t("websiteEditor.notPublished")}</Badge>
            )}
            <Badge tone="neutral">
              {t(`websiteEditor.${site.visibility === "passcode" ? "passcodeMode" : site.visibility}`)}
            </Badge>
          </p>
          {dirty && <p className="mb-3 text-sm text-warning">{t("websiteEditor.unpublishedChanges")}</p>}
          <div className="flex flex-wrap gap-2">
            <a href={`/${site.slug}?preview=1`} target="_blank" rel="noopener" className={buttonClass("secondary")}>
              {t("websiteEditor.preview")}
            </a>
            {site.published && (
              <a href={`/${site.slug}`} target="_blank" rel="noopener" className={buttonClass("secondary")}>
                {t("websiteEditor.open")}
              </a>
            )}
            <CopyButton text={url} label={t("guestLink.copy")} copiedLabel={t("guestLink.copied")} />
            {canPublish && (
              <form action={publishAction.bind(null, eventId)}>
                <SubmitButton>{t("websiteEditor.publish")}</SubmitButton>
              </form>
            )}
            {canPublish && site.published && (
              <form action={unpublishAction.bind(null, eventId)}>
                <SubmitButton variant="ghost">{t("websiteEditor.unpublish")}</SubmitButton>
              </form>
            )}
          </div>
          {!canPublish && <p className="mt-3 text-sm text-muted">{t("websiteEditor.publishHostOnly")}</p>}
        </Card>
        <Card>
          <CardTitle>{t("websiteEditor.share")}</CardTitle>
          <div className="mx-auto w-40 rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR code" role="img" />
          <p className="mt-2 text-center text-xs text-muted">{t("websiteEditor.qrHelp")}</p>
          <a href={`/events/${eventId}/website/qr`} className={buttonClass("ghost", "mt-1 w-full")}>
            {t("websiteEditor.downloadQr")}
          </a>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>{t("websiteEditor.address")}</CardTitle>
          <SimpleForm action={slugAction.bind(null, eventId)} className="space-y-3">
            <Field label={`${appUrl()}/`} htmlFor="slug" hint={t("websiteEditor.addressHelp")}>
              <Input id="slug" name="slug" defaultValue={site.slug} pattern="[a-z0-9-]{3,60}" required />
            </Field>
            <SubmitButton variant="secondary">{t("websiteEditor.saveAddress")}</SubmitButton>
          </SimpleForm>
        </Card>
        <Card>
          <CardTitle>{t("websiteEditor.visibility")}</CardTitle>
          <SimpleForm action={visibilityAction.bind(null, eventId)} className="space-y-3">
            {(["unlisted", "passcode", "public"] as const).map((v) => (
              <label key={v} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="radio" name="visibility" value={v} defaultChecked={site.visibility === v} />
                {t(`websiteEditor.${v === "passcode" ? "passcodeMode" : v}`)}
              </label>
            ))}
            <Field label={t("websiteEditor.passcode")} htmlFor="passcode" hint={t("websiteEditor.passcodeHelp")}>
              <Input id="passcode" name="passcode" autoComplete="off" maxLength={40} />
            </Field>
            <SubmitButton variant="secondary">{t("websiteEditor.saveVisibility")}</SubmitButton>
          </SimpleForm>
        </Card>
      </div>

      {/* Content editor: one form; image and move buttons save the draft first */}
      <form action={saveDraftAction.bind(null, eventId)} className="space-y-4">
        {/* Default button for Enter key: saves the draft rather than triggering an upload or move */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden />
        <Card>
          <CardTitle>{t("websiteEditor.look")}</CardTitle>
          <fieldset className="mb-4">
            <legend className="mb-2 text-sm font-medium">{t("websiteEditor.theme")}</legend>
            <div className="flex flex-wrap gap-2">
              {SITE_THEMES.map((th) => (
                <label key={th} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm">
                  <input type="radio" name="theme" value={th} defaultChecked={c.theme === th} /> {t(`websiteEditor.themes.${th}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="mb-4">
            <legend className="mb-2 text-sm font-medium">{t("websiteEditor.accent")}</legend>
            <div className="flex flex-wrap gap-2">
              {SITE_ACCENTS.map((a) => (
                <label key={a} className="relative cursor-pointer">
                  <input type="radio" name="accent" value={a} defaultChecked={c.accent === a} className="peer sr-only" />
                  <span className="block h-10 w-10 rounded-full ring-offset-2 ring-offset-surface peer-checked:ring-2 peer-checked:ring-text peer-focus-visible:ring-2" style={{ background: a }} />
                  <span className="sr-only">{a}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mb-4 sm:w-1/2">
            <Field label={t("websiteEditor.monogram")} htmlFor="monogram">
              <Input id="monogram" name="monogram" defaultValue={c.monogram} maxLength={12} />
            </Field>
          </div>
          <p className="mb-2 text-sm font-medium">{t("websiteEditor.cover")}</p>
          <Photos ids={c.coverImageId ? [c.coverImageId] : []} target="cover" t={t} eventId={eventId} single />
        </Card>

        <h2 className="pt-2 text-lg font-semibold">{t("websiteEditor.sections")}</h2>
        {c.order.map((key, i) => (
          <Card key={key} id={`section-${key}`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{t(`websiteEditor.sectionNames.${key}`)}</h3>
              <div className="flex items-center gap-1">
                <label className="mr-2 flex min-h-10 items-center gap-2 text-sm">
                  <input type="checkbox" name={`${key}.visible`} defaultChecked={c.sections[key].visible} className="h-5 w-5" />
                  {t("websiteEditor.show")}
                </label>
                <button type="submit" formAction={moveSectionAction.bind(null, eventId, key, "up")} disabled={i === 0} aria-label={t("websiteEditor.moveUp")} className="min-h-10 min-w-10 rounded-md hover:bg-surface-muted disabled:opacity-30">
                  ↑
                </button>
                <button type="submit" formAction={moveSectionAction.bind(null, eventId, key, "down")} disabled={i === c.order.length - 1} aria-label={t("websiteEditor.moveDown")} className="min-h-10 min-w-10 rounded-md hover:bg-surface-muted disabled:opacity-30">
                  ↓
                </button>
              </div>
            </div>
            <div className="space-y-3">{sectionBody(key)}</div>
          </Card>
        ))}
        <div className="sticky bottom-0 -mx-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur">
          <SubmitButton>{t("websiteEditor.saveDraft")}</SubmitButton>
        </div>
      </form>
    </div>
  );
}
