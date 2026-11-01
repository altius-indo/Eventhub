import { notFound } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { createTranslator, formatDay, formatTime } from "@/i18n/core";
import { getDb } from "@/db";
import { getPortalData } from "@/lib/rsvp";
import { getSiteContext, siteLocale } from "@/lib/server/site-context";
import { GuestLogistics } from "../guest-logistics";

export const metadata = { robots: { index: false } };

/** A family's personal itinerary, printable for elders (ITN-07). Guest link cookie only. */
export default async function GuestItinerary({ params, searchParams }: PageProps<"/[slug]/itinerary">) {
  const { slug } = await params;
  const sp = await searchParams;
  const ctx = await getSiteContext(slug);
  if (!ctx?.guest) notFound();
  const locale = await siteLocale(sp.lang, ctx.guest.household.locale);
  const t = createTranslator(locale);
  const portal = await getPortalData(getDb(), ctx.guest.household);
  return (
    <article lang={locale} className="print-sheet mx-auto min-h-dvh max-w-2xl bg-white p-6 text-black">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm">{ctx.event.name}</p>
          <h1 className="text-2xl font-semibold">{t("portal.hello", { family: portal.household.name })}</h1>
        </div>
        <PrintButton label={t("logistics.print")} />
      </div>
      <section className="mb-6">
        <h2 className="mb-2 border-b border-black text-xl font-semibold">{t("itinerary.title")}</h2>
        {portal.functions.map((fn) => (
          <div key={fn.id} className="mb-3" style={{ breakInside: "avoid" }}>
            <p className="font-semibold">
              {fn.name} · {[fn.date && formatDay(locale, fn.date, { weekday: "long", day: "numeric", month: "long" }), fn.startTime && formatTime(locale, fn.startTime)].filter(Boolean).join(", ")}
            </p>
            <p className="text-sm">{[fn.venueName, fn.venueAddress].filter(Boolean).join(", ")}</p>
            {fn.dressCode && (
              <p className="text-sm">
                {t("schedule.dressCode")}: {fn.dressCode}
              </p>
            )}
            <p className="text-sm">
              {portal.members
                .filter((m) => m.functionIds.includes(fn.id))
                .map((m) => m.name)
                .join(", ")}
            </p>
          </div>
        ))}
      </section>
      <GuestLogistics
        event={ctx.event}
        household={portal.household}
        memberNames={new Map(portal.members.map((m) => [m.id, m.name]))}
        t={t}
        locale={locale}
        cardClass="border border-gray-300"
        headingClass="font-semibold"
      />
    </article>
  );
}
