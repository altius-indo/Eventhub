import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/confirm-button";
import { BlockFields, HotelFields } from "@/components/hotel-fields";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Input, Select, buttonClass } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatInr } from "@/i18n/core";
import { allocationView, getHotel, HotelError, unallocatedGuests } from "@/lib/hotels";
import { getEventContext } from "@/lib/server/event-context";
import { blockLabels, hotelLabels } from "@/lib/server/m4-labels";
import { getTranslator } from "@/lib/server/session";
import {
  assignRoomAction,
  createBlockAction,
  deleteBlockAction,
  deleteHotelAction,
  renameRoomAction,
  unassignRoomAction,
  updateBlockAction,
  updateHotelAction,
} from "../actions";
import { isUuid } from "@/lib/ids";

export default async function HotelPage({ params }: PageProps<"/events/[eventId]/logistics/hotels/[hotelId]">) {
  const { eventId, hotelId } = await params;
  const ctx = await getEventContext(eventId);
  if (!isUuid(hotelId)) notFound();
  const db = getDb();
  const hotel = await getHotel(db, eventId, hotelId).catch((e) => {
    if (e instanceof HotelError) notFound();
    throw e;
  });
  const [blocks, unallocated] = await Promise.all([allocationView(db, eventId, hotelId), unallocatedGuests(db, eventId)]);
  const { t, locale } = await getTranslator();
  const canEdit = ctx.can("travel.edit");
  const roomName = (r: { label: string | null; sortOrder: number }) => r.label || `${t("hotels.room")} ${r.sortOrder}`;
  const day = (d: string) => formatDay(locale, d, { day: "numeric", month: "short" });
  const families = new Map<string, typeof unallocated>();
  for (const u of unallocated) families.set(u.household.id, [...(families.get(u.household.id) ?? []), u]);

  return (
    <div className="space-y-4">
      <Link href={`/events/${eventId}/logistics/hotels`} className="text-sm text-primary hover:underline">
        ← {t("hotels.title")}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">{hotel.name}</h2>
        <a href={`/events/${eventId}/logistics/hotels/${hotelId}/rooming-list`} className={buttonClass("secondary")}>
          {t("hotels.roomingList")}
        </a>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          {blocks.map((b) => (
            <Card key={b.id}>
              <CardTitle action={<Badge>{t("hotels.dates", { in: day(b.checkIn), out: day(b.checkOut) })}</Badge>}>
                {b.roomType} · {b.maxOccupancy}
                {b.ratePaise != null && <span className="ml-2 text-sm font-normal text-muted">{formatInr(locale, b.ratePaise)}</span>}
              </CardTitle>
              <ul className="grid gap-2 sm:grid-cols-2">
                {b.rooms.map((r) => (
                  <li key={r.id} className={`rounded-lg border p-3 ${r.over ? "border-danger" : "border-border"}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-medium">{roomName(r)}</span>
                      {r.over && <Badge tone="danger">{t("hotels.over")}</Badge>}
                    </div>
                    {r.occupants.length === 0 ? (
                      <p className="text-sm text-muted">{t("hotels.empty_room")}</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {r.occupants.map((o) => (
                          <li key={o.id} className="flex items-center justify-between gap-2">
                            <span>
                              {o.name} <span className="text-muted">· {o.householdName}</span>
                              {o.ageGroup !== "adult" && <span className="text-muted"> · {t(`ages.${o.ageGroup}`)}</span>}
                              {(o.checkIn !== b.checkIn || o.checkOut !== b.checkOut) && (
                                <span className="block text-xs text-muted">{t("hotels.dates", { in: day(o.checkIn), out: day(o.checkOut) })}</span>
                              )}
                            </span>
                            {canEdit && (
                              <form action={unassignRoomAction.bind(null, eventId, r.id, o.id)}>
                                <button type="submit" className="min-h-9 rounded-md px-2 text-xs text-danger hover:bg-danger-soft">
                                  {t("hotels.remove")}
                                </button>
                              </form>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {canEdit && (
                      <SimpleForm action={renameRoomAction.bind(null, eventId, r.id)} className="mt-2 flex gap-1">
                        <Input name="label" defaultValue={r.label ?? ""} placeholder={t("hotels.roomLabel")} aria-label={t("hotels.roomLabel")} className="min-h-9 text-sm" maxLength={30} />
                        <SubmitButton variant="ghost" className="min-h-9 px-2 text-xs">
                          {t("hotels.rename")}
                        </SubmitButton>
                      </SimpleForm>
                    )}
                  </li>
                ))}
              </ul>
              {canEdit && (
                <details className="mt-3 border-t border-border pt-3">
                  <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">{t("hotels.edit")}</summary>
                  <SimpleForm action={updateBlockAction.bind(null, eventId, b.id)} className="mt-2 space-y-3">
                    <BlockFields labels={blockLabels(t)} block={b} idBase={`b${b.id}_`} />
                    <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
                  </SimpleForm>
                  <form action={deleteBlockAction.bind(null, eventId, b.id)} className="mt-2">
                    <ConfirmButton variant="ghost" className="text-danger" confirm={t("hotels.deleteBlockConfirm")}>
                      {t("hotels.deleteBlock")}
                    </ConfirmButton>
                  </form>
                </details>
              )}
            </Card>
          ))}
          {canEdit && (
            <Card>
              <CardTitle>{t("hotels.addBlock")}</CardTitle>
              <SimpleForm action={createBlockAction.bind(null, eventId, hotelId)}>
                <BlockFields labels={blockLabels(t)} block={{ checkIn: ctx.event.startDate ?? "", checkOut: ctx.event.endDate ?? "" }} idBase="new_" />
                <SubmitButton>{t("hotels.addBlock")}</SubmitButton>
              </SimpleForm>
            </Card>
          )}
        </div>

        {/* Allocation panel */}
        <div className="space-y-4">
          {canEdit && blocks.some((b) => b.rooms.length) && (
            <Card>
              <CardTitle>{t("hotels.unallocated")}</CardTitle>
              <p className="mb-3 text-sm text-muted">{t("hotels.unallocatedHelp")}</p>
              {families.size === 0 ? (
                <p className="text-sm">{t("hotels.noneUnallocated")}</p>
              ) : (
                <SimpleForm action={assignRoomAction.bind(null, eventId)} className="space-y-3">
                  <ul className="max-h-96 space-y-2 overflow-y-auto">
                    {[...families.values()].map((members) => (
                      <li key={members[0].household.id}>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{members[0].household.name}</p>
                        {members.map(({ guest }) => (
                          <label key={guest.id} className="flex min-h-10 items-center gap-2 text-sm">
                            <input type="checkbox" name="guestIds" value={guest.id} className="h-5 w-5" />
                            {guest.name}
                            {guest.ageGroup !== "adult" && <span className="text-muted">({t(`ages.${guest.ageGroup}`)})</span>}
                            {guest.accessibilityNotes && <Badge tone="warning">♿</Badge>}
                          </label>
                        ))}
                      </li>
                    ))}
                  </ul>
                  <Field label={t("hotels.assign")} htmlFor="roomId">
                    <Select id="roomId" name="roomId">
                      {blocks.flatMap((b) =>
                        b.rooms.map((r) => (
                          <option key={r.id} value={r.id}>
                            {b.roomType} · {roomName(r)} ({r.occupants.length}/{b.maxOccupancy})
                          </option>
                        )),
                      )}
                    </Select>
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={t("hotels.checkIn")} htmlFor="assign-in">
                      <Input id="assign-in" name="checkIn" type="date" />
                    </Field>
                    <Field label={t("hotels.checkOut")} htmlFor="assign-out">
                      <Input id="assign-out" name="checkOut" type="date" />
                    </Field>
                  </div>
                  <SubmitButton className="w-full">{t("hotels.assign")}</SubmitButton>
                </SimpleForm>
              )}
            </Card>
          )}
          {canEdit && (
            <Card>
              <SimpleForm action={updateHotelAction.bind(null, eventId, hotelId)}>
                <HotelFields labels={hotelLabels(t)} hotel={hotel} />
                <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
              </SimpleForm>
              <form action={deleteHotelAction.bind(null, eventId, hotelId)} className="mt-3">
                <ConfirmButton variant="ghost" className="text-danger" confirm={t("hotels.deleteHotelConfirm")}>
                  {t("hotels.deleteHotel")}
                </ConfirmButton>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
