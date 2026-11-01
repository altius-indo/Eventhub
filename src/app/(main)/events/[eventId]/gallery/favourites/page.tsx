import Link from "next/link";
import { MediaGrid } from "@/components/media-grid";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { getDb } from "@/db";
import { vendors } from "@/db/schema";
import { formatDateTime, formatDay } from "@/i18n/core";
import { inArray } from "drizzle-orm";
import { listFavourites, listSelections, photoBookings } from "@/lib/gallery";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { createSelectionAction } from "../actions";

/** Favourites and the printed-album selections shared with the photographer (GAL-07). */
export default async function FavouritesPage({ params, searchParams }: PageProps<"/events/[eventId]/gallery/favourites">) {
  const { eventId } = await params;
  const sp = await searchParams;
  const ctx = await getEventContext(eventId);
  const { t, locale } = await getTranslator();
  const db = getDb();
  const mine = sp.who !== "all";
  const [favs, selections, bookings] = await Promise.all([listFavourites(db, eventId, mine ? { userId: ctx.user.id } : {}), listSelections(db, eventId), photoBookings(db, eventId)]);
  const vendorIds = [...new Set(bookings.map((b) => b.vendorId))];
  const names = new Map(vendorIds.length ? (await db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, vendorIds))).map((v) => [v.id, v.name]) : []);
  const bookingOptions = [...new Map(bookings.map((b) => [b.bookingId, b])).values()];
  const base = `/events/${eventId}/gallery`;
  const pill = (active: boolean) => `inline-flex min-h-11 items-center rounded-full border px-4 text-sm ${active ? "border-primary bg-primary-soft" : "border-border"}`;

  return (
    <div className="space-y-5">
      <PageHeader title={t("gallery.favourites.title")} subtitle={t("gallery.favourites.help")} />
      <nav className="flex gap-2" aria-label={t("gallery.favourites.title")}>
        <Link href={`${base}/favourites`} className={pill(mine)} aria-current={mine ? "page" : undefined}>
          {t("gallery.favourites.mine")}
        </Link>
        <Link href={`${base}/favourites?who=all`} className={pill(!mine)} aria-current={!mine ? "page" : undefined}>
          {t("gallery.favourites.everyone")}
        </Link>
      </nav>
      {favs.length === 0 ? (
        <p className="text-sm text-muted">{t("gallery.favourites.empty")}</p>
      ) : (
        <MediaGrid
          items={favs.map(({ item, votes }) => ({
            id: item.id,
            href: `${base}/media/${item.id}`,
            thumb: `${base}/media/${item.id}/thumb`,
            video: item.kind === "video",
            label: item.filename,
            badge: !mine && votes > 1 ? <Badge tone="primary">★ {votes}</Badge> : undefined,
          }))}
        />
      )}

      <Card className="space-y-3">
        <h2 className="text-lg font-semibold">{t("gallery.selections.title")}</h2>
        <p className="text-sm text-muted">{t("gallery.selections.help")}</p>
        {selections.length === 0 ? (
          <p className="text-sm text-muted">{t("gallery.selections.empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {selections.map(({ selection: s, items }) => (
              <li key={s.id}>
                <Link href={`${base}/selections/${s.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2 hover:underline">
                  <span className="font-medium">{s.title}</span>
                  <span className="flex flex-wrap gap-1 text-sm text-muted">
                    {s.vendorId && names.get(s.vendorId)} · {t("gallery.selections.items", { count: items })}
                    {s.deadline && ` · ${t("gallery.selections.deadlineOn", { date: formatDay(locale, s.deadline) })}`}
                    <Badge tone={s.sharedAt ? "success" : "neutral"}>{s.sharedAt ? t("gallery.selections.shared", { date: formatDateTime(locale, s.sharedAt) }) : t("gallery.selections.notShared")}</Badge>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {bookingOptions.length === 0 ? (
          <p className="text-sm text-muted">{t("gallery.selections.none")}</p>
        ) : (
          <details>
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">+ {t("gallery.selections.new")}</summary>
            <SimpleForm action={createSelectionAction.bind(null, eventId)} className="mt-2 space-y-3">
              <Field label={t("gallery.selections.booking")} htmlFor="sel-booking">
                <Select id="sel-booking" name="bookingId" required>
                  {bookingOptions.map((b) => (
                    <option key={b.bookingId} value={b.bookingId}>
                      {names.get(b.vendorId)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("gallery.albumTitle")} htmlFor="sel-title">
                <Input id="sel-title" name="title" required maxLength={80} />
              </Field>
              <Field label={t("gallery.selections.deadline")} htmlFor="sel-deadline">
                <Input id="sel-deadline" name="deadline" type="date" />
              </Field>
              <Field label={t("gallery.selections.note")} htmlFor="sel-note">
                <Textarea id="sel-note" name="note" rows={2} maxLength={1000} />
              </Field>
              <SubmitButton>{t("gallery.selections.create")}</SubmitButton>
            </SimpleForm>
          </details>
        )}
      </Card>
    </div>
  );
}
