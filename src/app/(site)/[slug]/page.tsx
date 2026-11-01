import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import type { CSSProperties, ReactNode } from "react";
import { ConfirmButton } from "@/components/confirm-button";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { TravelFields } from "@/components/travel-fields";
import { Field, Input, Select } from "@/components/ui";
import { getDb } from "@/db";
import type { Event, EventFunction, SiteContent } from "@/db/schema";
import { createTranslator, formatDay, formatTime, type Locale, type Translator } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { passUrl } from "@/lib/guest-links";
import { getPortalData, rsvpOpen, type PortalData } from "@/lib/rsvp";
import { travelLabels, travelSummary } from "@/lib/server/m3-labels";
import { appUrl } from "@/lib/server/session";
import { getSiteContext, siteLocale } from "@/lib/server/site-context";
import { todayIn } from "@/lib/tasks";
import { hasTravel, travelFor } from "@/lib/travel";
import { defaultContent, pick } from "@/lib/website";
import { GuestLogistics } from "./guest-logistics";
import {
  addPlusOneAction,
  findInvitationAction,
  guestRsvpAction,
  guestTravelAction,
  removePlusOneAction,
  setSiteLanguageAction,
  unlockAction,
} from "./actions";

type Props = PageProps<"/[slug]">;

const themes = {
  traditional: { wrap: "bg-[#fbf6ee] text-[#2a1f1a]", heading: "font-serif", card: "bg-white/80 border border-[#eadfcd]", hero: "text-center" },
  modern: { wrap: "bg-white text-[#141414]", heading: "font-sans font-bold uppercase tracking-wide", card: "bg-[#f6f6f6]", hero: "text-center" },
  minimal: { wrap: "bg-[#fafafa] text-[#222]", heading: "font-sans font-light", card: "bg-white border border-[#e6e6e6]", hero: "text-left" },
} as const;

async function load(props: Props) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const ctx = await getSiteContext(slug);
  if (!ctx) return null;
  const preview = sp.preview === "1" && ctx.isMember;
  const content: SiteContent | null = preview ? ctx.website.draft : ctx.website.published;
  const locale = await siteLocale(sp.lang, ctx.guest?.household.locale);
  return { ...ctx, slug, preview, content, locale };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const data = await load(props);
  if (!data) return { robots: { index: false } };
  const content = data.content ?? defaultContent(data.event);
  const title = pick(content.sections.welcome.headline, data.locale) || data.event.coupleNames || data.event.name;
  const indexable = !!data.website.published && data.website.visibility === "public" && !data.preview;
  const description = [data.event.startDate && formatDay(data.locale, data.event.startDate, { dateStyle: "long" }), data.event.city].filter(Boolean).join(" · ");
  return {
    title: { absolute: title },
    description,
    robots: indexable ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, type: "website", url: `${appUrl()}/${data.slug}` },
  };
}

function Section({ id, title, theme, children }: { id: string; title: string; theme: (typeof themes)[keyof typeof themes]; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-3xl px-4 py-10">
      <h2 className={`mb-5 text-2xl sm:text-3xl ${theme.heading}`} style={{ color: "var(--accent)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function FunctionCard({ fn, t, locale, showVenue, cardClass, children }: { fn: EventFunction; t: Translator; locale: Locale; showVenue: boolean; cardClass: string; children?: ReactNode }) {
  return (
    <article className={`rounded-2xl p-5 ${cardClass}`}>
      <h3 className="text-xl font-semibold">{fn.name}</h3>
      <p className="mt-1 text-sm opacity-80">
        {[
          fn.date && formatDay(locale, fn.date, { weekday: "long", day: "numeric", month: "long" }),
          fn.startTime && `${formatTime(locale, fn.startTime)}${fn.endTime ? ` – ${formatTime(locale, fn.endTime)}` : ""}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {showVenue ? (
        <>
          {fn.venueName && <p className="mt-2 font-medium">{fn.venueName}</p>}
          {fn.venueAddress && <p className="whitespace-pre-line text-sm opacity-80">{fn.venueAddress}</p>}
          {fn.mapUrl && (
            <a href={fn.mapUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm underline" style={{ color: "var(--accent)" }}>
              {t("schedule.map")} ↗
            </a>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm opacity-70">{fn.venueName ? `${fn.venueName} · ` : ""}{t("portal.venueHidden")}</p>
      )}
      {fn.dressCode && (
        <p className="mt-2 text-sm">
          <span className="opacity-70">{t("schedule.dressCode")}:</span> {fn.dressCode}
        </p>
      )}
      {fn.description && <p className="mt-2 whitespace-pre-line text-sm">{fn.description}</p>}
      {children}
    </article>
  );
}

const btn = "inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-medium text-white disabled:opacity-60";

export default async function WeddingSite(props: Props) {
  const data = await load(props);
  if (!data) notFound();
  const { website, event, guest, isMember, preview, slug, locale } = data;
  const t = createTranslator(locale);

  // Not published: only the team (preview) and invited families may see anything.
  if (!data.content && !guest && !isMember) notFound();
  if (!data.content && isMember && !guest && !preview) notFound();
  const content = data.content ?? { ...defaultContent(event), theme: website.draft.theme, accent: website.draft.accent, monogram: website.draft.monogram, coverImageId: website.draft.coverImageId };
  const theme = themes[content.theme];
  const style = { "--accent": content.accent } as CSSProperties;

  const langSwitch = (
    <form action={setSiteLanguageAction.bind(null, slug)} className="flex gap-1 text-sm" aria-label={t("site.language")}>
      {preview && <input type="hidden" name="preview" value="1" />}
      {(["en", "hi"] as const).map((l) => (
        <button key={l} type="submit" name="lang" value={l} aria-pressed={locale === l} className={`min-h-9 rounded-full px-3 ${locale === l ? "bg-black/10 font-semibold" : "opacity-70"}`}>
          {l === "en" ? "English" : "हिन्दी"}
        </button>
      ))}
    </form>
  );

  // Passcode gate (team members and invited families skip it)
  if (!data.unlocked && !guest && !isMember) {
    return (
      <div lang={locale} style={style} className={`min-h-dvh ${theme.wrap}`}>
        <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-5 px-4">
          <div className="flex justify-end">{langSwitch}</div>
          <h1 className={`text-2xl ${theme.heading}`} style={{ color: "var(--accent)" }}>
            {t("site.passcodeTitle")}
          </h1>
          <p className="text-sm opacity-80">{t("site.passcodeHelp")}</p>
          <SimpleForm action={unlockAction.bind(null, slug)} className="space-y-3">
            <input type="hidden" name="lang" value={locale} />
            <Field label={t("site.passcode")} htmlFor="passcode">
              <Input id="passcode" name="passcode" type="password" autoComplete="off" required />
            </Field>
            <SubmitButton className="rounded-full" style={{ background: "var(--accent)" }}>
              {t("site.unlock")}
            </SubmitButton>
          </SimpleForm>
        </div>
      </div>
    );
  }

  const db = getDb();
  const allFunctions = await listFunctions(db, event.id);
  const portal: PortalData | null = guest ? await getPortalData(db, guest.household) : null;
  const s = content.sections;
  const names = pick(s.welcome.headline, locale) || event.coupleNames || event.name;

  const today = todayIn(event.timezone);
  const days = event.startDate ? Math.round((Date.parse(event.startDate) - Date.parse(today)) / 86_400_000) : null;
  const dates = event.startDate
    ? event.endDate && event.endDate !== event.startDate
      ? `${formatDay(locale, event.startDate, { day: "numeric", month: "long" })} – ${formatDay(locale, event.endDate, { day: "numeric", month: "long", year: "numeric" })}`
      : formatDay(locale, event.startDate, { day: "numeric", month: "long", year: "numeric" })
    : null;

  const publicFunctions = allFunctions.filter((f) => f.isPublic);
  const sectionView: Record<SiteContent["order"][number], ReactNode> = {
    welcome: null, // rendered as the hero
    story: s.story.visible && (
      <Section id="story" title={pick(s.story.title, locale)} theme={theme}>
        <p className="whitespace-pre-line leading-relaxed">{pick(s.story.body, locale)}</p>
        {s.story.imageIds.length > 0 && (
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {s.story.imageIds.map((id) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={id} src={`/site-images/${id}`} alt="" loading="lazy" className="aspect-[4/5] w-full rounded-xl object-cover" />
            ))}
          </div>
        )}
      </Section>
    ),
    events: s.events.visible && !guest && publicFunctions.length > 0 && (
      <Section id="events" title={pick(s.events.title, locale)} theme={theme}>
        <div className="grid gap-4">
          {publicFunctions.map((fn) => (
            <FunctionCard key={fn.id} fn={fn} t={t} locale={locale} showVenue={fn.venuePublic} cardClass={theme.card} />
          ))}
        </div>
        <a href={`/${slug}/calendar.ics`} className="mt-4 inline-block text-sm underline" style={{ color: "var(--accent)" }}>
          {t("schedule.calendar")}
        </a>
      </Section>
    ),
    travel: s.travel.visible && (
      <Section id="travel" title={pick(s.travel.title, locale)} theme={theme}>
        <p className="whitespace-pre-line leading-relaxed">{pick(s.travel.body, locale)}</p>
      </Section>
    ),
    faqs: s.faqs.visible && s.faqs.items.length > 0 && (
      <Section id="faqs" title={pick(s.faqs.title, locale)} theme={theme}>
        <div className="space-y-2">
          {s.faqs.items.map((f, i) => (
            <details key={i} className={`rounded-xl p-4 ${theme.card}`}>
              <summary className="cursor-pointer font-medium">{pick(f.q, locale)}</summary>
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{pick(f.a, locale)}</p>
            </details>
          ))}
        </div>
      </Section>
    ),
    gallery: s.gallery.visible && s.gallery.imageIds.length > 0 && (
      <Section id="gallery" title={pick(s.gallery.title, locale)} theme={theme}>
        <div className="columns-2 gap-3 sm:columns-3">
          {s.gallery.imageIds.map((id) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={id} src={`/site-images/${id}`} alt="" loading="lazy" className="mb-3 w-full break-inside-avoid rounded-xl" />
          ))}
        </div>
      </Section>
    ),
    gifts: s.gifts.visible && (
      <Section id="gifts" title={pick(s.gifts.title, locale)} theme={theme}>
        <p className="whitespace-pre-line text-lg leading-relaxed">{pick(s.gifts.body, locale)}</p>
      </Section>
    ),
    contact: s.contact.visible && s.contact.people.length > 0 && (
      <Section id="contact" title={pick(s.contact.title, locale)} theme={theme}>
        <ul className="grid gap-3 sm:grid-cols-2">
          {s.contact.people.map((p, i) => (
            <li key={i} className={`rounded-xl p-4 ${theme.card}`}>
              <p className="font-medium">{p.name}</p>
              {p.phone && (
                <a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`} className="text-sm underline" style={{ color: "var(--accent)" }}>
                  {p.phone}
                </a>
              )}
            </li>
          ))}
        </ul>
      </Section>
    ),
  };

  return (
    <div lang={locale} style={style} className={`min-h-dvh ${theme.wrap}`}>
      {preview && <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">{t("site.preview")}</div>}

      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <span className={`text-lg ${theme.heading}`} style={{ color: "var(--accent)" }}>
          {content.monogram}
        </span>
        {langSwitch}
      </header>

      {/* Hero / welcome */}
      <section className={`relative mx-auto max-w-3xl px-4 pb-8 ${theme.hero}`}>
        {content.coverImageId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/site-images/${content.coverImageId}`} alt="" className="mb-6 aspect-[16/10] w-full rounded-3xl object-cover" />
        )}
        <h1 className={`text-4xl leading-tight sm:text-5xl ${theme.heading}`} style={{ color: "var(--accent)" }}>
          {names}
        </h1>
        {(dates || event.city) && <p className="mt-3 text-lg opacity-80">{[dates, event.city].filter(Boolean).join(" · ")}</p>}
        {days !== null && days >= 0 && (
          <p className="mt-2 text-sm font-medium uppercase tracking-widest opacity-70">{days === 0 ? t("site.today") : t("site.countdown", { days })}</p>
        )}
        {s.welcome.visible && pick(s.welcome.message, locale) && <p className="mx-auto mt-5 max-w-xl whitespace-pre-line text-lg leading-relaxed">{pick(s.welcome.message, locale)}</p>}
      </section>

      {portal && guest && <Personal slug={slug} portal={portal} t={t} locale={locale} theme={theme} event={event} />}

      {content.order.map((key) => (
        <div key={key}>{sectionView[key]}</div>
      ))}

      {!guest && (
        <Section id="find" title={t("site.findTitle")} theme={theme}>
          <p className="mb-4 text-sm opacity-80">{t("site.findHelp")}</p>
          <SimpleForm action={findInvitationAction.bind(null, slug)} className="max-w-sm space-y-3">
            <input type="hidden" name="lang" value={locale} />
            <Field label={t("site.findInput")} htmlFor="contact">
              <Input id="contact" name="contact" autoComplete="tel" required />
            </Field>
            <SubmitButton className="rounded-full" style={{ background: "var(--accent)" }}>
              {t("site.findButton")}
            </SubmitButton>
          </SimpleForm>
        </Section>
      )}

      <footer className="py-10 text-center text-xs opacity-60">{t("site.madeWith")}</footer>
    </div>
  );
}

/** The family's own area: replies, food, extra people, travel and entry pass (WEB-05, ITN-04). */
async function Personal({
  slug,
  portal,
  t,
  locale,
  theme,
  event,
}: {
  slug: string;
  portal: PortalData;
  t: Translator;
  locale: Locale;
  theme: (typeof themes)[keyof typeof themes];
  event: Event;
}) {
  const open = rsvpOpen(event);
  const travel = await travelFor(getDb(), portal.members.map((m) => m.id));
  // Entry pass: identifies the family at check-in only; it is not their login link (ADR-0014).
  const pass = passUrl(appUrl(), portal.household);
  const qr = await QRCode.toString(pass, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  const remaining = portal.household.plusOnesAllowed - portal.plusOnesUsed;
  const head = portal.members.find((m) => m.isHead) ?? portal.members[0];
  const accentBtn = { background: "var(--accent)" };

  return (
    <div className="border-y border-black/5 bg-black/[0.02]">
      <Section id="rsvp" title={t("portal.hello", { family: portal.household.name })} theme={theme}>
        <p className="mb-2 leading-relaxed">{t("portal.intro")}</p>
        {event.rsvpDeadline && (
          <p className="mb-5 text-sm font-medium">
            {open ? t("rsvp.replyBy", { date: formatDay(locale, event.rsvpDeadline, { day: "numeric", month: "long" }) }) : t("rsvp.closed", { date: formatDay(locale, event.rsvpDeadline, { day: "numeric", month: "long" }) })}
          </p>
        )}

        {portal.functions.length === 0 ? (
          <p className="opacity-80">{t("portal.noEvents")}</p>
        ) : (
          <SimpleForm action={guestRsvpAction.bind(null, slug)} className="space-y-4">
            <fieldset disabled={!open} className="space-y-4">
              <legend className="sr-only">{t("portal.yourEvents")}</legend>
              {portal.functions.map((fn) => (
                <FunctionCard key={fn.id} fn={fn} t={t} locale={locale} showVenue cardClass={theme.card}>
                  <div className="mt-4 space-y-3 border-t border-black/10 pt-4">
                    {portal.members
                      .filter((m) => m.functionIds.includes(fn.id))
                      .map((m) => (
                        <fieldset key={m.id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <legend className="float-left font-medium sm:float-none">{m.name}</legend>
                          <div className="clear-left flex flex-wrap gap-1.5">
                            {(["attending", "maybe", "declined"] as const).map((st) => (
                              <label key={st} className="cursor-pointer">
                                <input type="radio" name={`r:${m.id}:${fn.id}`} value={st} defaultChecked={m.rsvp[fn.id] === st} className="peer sr-only" />
                                <span className="inline-flex min-h-11 items-center rounded-full border border-black/15 px-4 text-sm peer-checked:border-transparent peer-checked:bg-[var(--accent)] peer-checked:text-white peer-focus-visible:ring-2 peer-focus-visible:ring-black/40">
                                  {t(`rsvp.${st}`)}
                                </span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      ))}
                  </div>
                </FunctionCard>
              ))}

              <div className={`rounded-2xl p-5 ${theme.card}`}>
                <h3 className="mb-3 text-lg font-semibold">{t("portal.food")}</h3>
                <div className="space-y-4">
                  {portal.members.map((m) => (
                    <div key={m.id} className="grid gap-2 sm:grid-cols-[10rem_1fr_1fr] sm:items-end">
                      <p className="font-medium">{m.name}</p>
                      <Field label={t("portal.food")} htmlFor={`diet-${m.id}`}>
                        <Select id={`diet-${m.id}`} name={`diet:${m.id}`} defaultValue={m.diet ?? ""}>
                          <option value="">{t("guestForm.dietNotSet")}</option>
                          {(["veg", "non_veg", "jain", "vegan", "other"] as const).map((d) => (
                            <option key={d} value={d}>
                              {t(`diets.${d}`)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t("portal.foodNotes")} htmlFor={`notes-${m.id}`}>
                        <Input id={`notes-${m.id}`} name={`notes:${m.id}`} defaultValue={m.dietNotes ?? ""} maxLength={200} />
                      </Field>
                    </div>
                  ))}
                </div>
              </div>
            </fieldset>
            {open && (
              <SubmitButton className={btn} style={accentBtn}>
                {t("rsvp.save")}
              </SubmitButton>
            )}
          </SimpleForm>
        )}

        {/* Extra people (+1s, children) */}
        {portal.household.plusOnesAllowed > 0 && (
          <div className={`mt-6 rounded-2xl p-5 ${theme.card}`}>
            <h3 className="mb-2 text-lg font-semibold">{t("portal.addPerson")}</h3>
            {portal.members
              .filter((m) => m.addedByGuest)
              .map((m) => (
                <form key={m.id} action={removePlusOneAction.bind(null, slug, m.id)} className="mb-2 flex items-center justify-between gap-2">
                  <span>
                    {m.name} {m.ageGroup !== "adult" && <span className="text-sm opacity-70">({t(`ages.${m.ageGroup}`)})</span>}
                  </span>
                  {open && (
                    <ConfirmButton variant="ghost" className="min-h-10 text-sm" confirm={`${t("portal.remove")} ${m.name}?`}>
                      {t("portal.remove")}
                    </ConfirmButton>
                  )}
                </form>
              ))}
            {open && remaining > 0 && (
              <SimpleForm action={addPlusOneAction.bind(null, slug)} className="mt-3 space-y-3">
                <p className="text-sm opacity-80">{t("portal.addHelp", { count: remaining })}</p>
                <input type="hidden" name="invitedWithId" value={head.id} />
                <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
                  <Field label={t("portal.name")} htmlFor="plus-name">
                    <Input id="plus-name" name="name" required maxLength={120} />
                  </Field>
                  <Field label={t("guestForm.ageGroup")} htmlFor="plus-age">
                    <Select id="plus-age" name="ageGroup" defaultValue="adult">
                      <option value="adult">{t("ages.adult")}</option>
                      <option value="child">{t("ages.child")}</option>
                      <option value="infant">{t("ages.infant")}</option>
                    </Select>
                  </Field>
                  <SubmitButton className={btn} style={accentBtn}>
                    {t("portal.add")}
                  </SubmitButton>
                </div>
              </SimpleForm>
            )}
          </div>
        )}
      </Section>

      <Section id="travel-details" title={t("travel.title")} theme={theme}>
        <p className="mb-4 text-sm opacity-80">{t("travel.help")}</p>
        <div className="space-y-3">
          {portal.members.map((m) => (
            <details key={m.id} className={`rounded-2xl p-4 ${theme.card}`} open={!hasTravel(travel.get(m.id)) && m.isHead}>
              <summary className="cursor-pointer">
                <span className="font-medium">{m.name}</span>
                <span className="block text-sm opacity-70">{hasTravel(travel.get(m.id)) ? travelSummary(t, locale, travel.get(m.id)!) : t("travel.none")}</span>
              </summary>
              <SimpleForm action={guestTravelAction.bind(null, slug, m.id)} className="mt-3 space-y-3">
                <TravelFields labels={travelLabels(t)} travel={travel.get(m.id)} idBase={`tr${m.id}_`} />
                {portal.members.length > 1 && (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" name="copyToAll" className="h-5 w-5" /> {t("travel.copyToAll")}
                  </label>
                )}
                <SubmitButton className={btn} style={accentBtn}>
                  {t("travel.save")}
                </SubmitButton>
              </SimpleForm>
            </details>
          ))}
        </div>
      </Section>

      <div className="mx-auto max-w-3xl px-4">
        <GuestLogistics
          event={event}
          household={portal.household}
          memberNames={new Map(portal.members.map((m) => [m.id, m.name]))}
          t={t}
          locale={locale}
          cardClass={theme.card}
          headingClass={theme.heading}
        />
      </div>

      <Section id="pass" title={t("portal.yourPass")} theme={theme}>
        <div className={`mx-auto max-w-xs rounded-2xl p-5 text-center ${theme.card}`}>
          <div className="mx-auto w-48 rounded-lg bg-white p-2" role="img" aria-label="QR code" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className="mt-3 font-semibold">{portal.household.name}</p>
          <p className="text-sm opacity-70">{t("portal.passHelp")}</p>
        </div>
        <p className="mt-4 text-center">
          <a href={`/${slug}/itinerary`} className="text-sm underline" style={{ color: "var(--accent)" }}>
            {t("itinerary.print")}
          </a>
        </p>
        {portal.functions.some((f) => f.date) && (
          <p className="mt-4 text-center">
            <a href={`/${slug}/calendar.ics`} className="text-sm underline" style={{ color: "var(--accent)" }}>
              {t("portal.addToCalendar")}
            </a>
          </p>
        )}
      </Section>
    </div>
  );
}
