import Link from "next/link";
import { notFound } from "next/navigation";
import { GuestFields } from "@/components/guest-fields";
import { HouseholdFields } from "@/components/household-fields";
import { SimpleForm } from "@/components/simple-form";
import { ConfirmButton } from "@/components/confirm-button";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Card, CardTitle } from "@/components/ui";
import { getDb } from "@/db";
import { listFunctions } from "@/lib/functions";
import { formatPhone, getHouseholdWithMembers, GuestError } from "@/lib/guests";
import { getEventContext } from "@/lib/server/event-context";
import { guestFieldLabels } from "@/lib/server/guest-form";
import { householdFieldLabels } from "@/lib/server/household-labels";
import { getTranslator } from "@/lib/server/session";
import { CopyButton } from "@/components/copy-button";
import { TravelFields } from "@/components/travel-fields";
import { Field, Input, Select, buttonClass } from "@/components/ui";
import { formatDateTime } from "@/i18n/core";
import { guestLinkMessage, guestLinkUrl, whatsappShareUrl } from "@/lib/guest-links";
import { getPortalData } from "@/lib/rsvp";
import { hasTravel, travelFor } from "@/lib/travel";
import { travelLabels, travelSummary } from "@/lib/server/m3-labels";
import { appUrl } from "@/lib/server/session";
import { householdOptOut } from "@/lib/broadcasts";
import {
  broadcastOptOutAction,
  familySettingsAction,
  recordRsvpAction,
  regenerateLinkAction,
  revokeLinkAction,
  saveTravelAction,
  sendGuestLinkAction,
} from "../actions";
import {
  addGuestAction,
  deleteHouseholdAction,
  removeGuestAction,
  saveInvitesAction,
  setHeadAction,
  updateGuestAction,
  updateHouseholdAction,
} from "../actions";
import { isUuid } from "@/lib/ids";

function ConfirmForm({ action, label, confirm, tone }: { action: () => Promise<void>; label: string; confirm: string; tone?: "danger" }) {
  return (
    <form action={action}>
      <ConfirmButton variant={tone === "danger" ? "ghost" : "secondary"} className={tone === "danger" ? "text-danger" : undefined} confirm={confirm}>
        {label}
      </ConfirmButton>
    </form>
  );
}

export default async function HouseholdPage({ params, searchParams }: PageProps<"/events/[eventId]/guests/[householdId]">) {
  const { eventId, householdId } = await params;
  const { created } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!isUuid(householdId)) notFound();
  const db = getDb();
  const household = await getHouseholdWithMembers(db, eventId, householdId).catch((e) => {
    if (e instanceof GuestError) notFound();
    throw e;
  });
  const fns = await listFunctions(db, eventId);
  const { t, locale } = await getTranslator();
  const portal = await getPortalData(db, household);
  const travel = await travelFor(db, household.members.map((m) => m.id));
  const link = guestLinkUrl(appUrl(), household);
  const head = household.members.find((m) => m.isHead) ?? household.members[0];
  const contacts = household.members.flatMap((m) => [
    ...(m.phone ? [{ value: `sms:${m.id}`, label: `${m.name} · SMS ${formatPhone(m.phone)}` }] : []),
    ...(m.email ? [{ value: `email:${m.id}`, label: `${m.name} · ${m.email}` }] : []),
  ]);
  const canEdit = ctx.can("guests.edit");
  const labels = guestFieldLabels(t);
  const optOut = await householdOptOut(db, eventId, householdId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/events/${eventId}/guests`} className="text-sm text-primary hover:underline">
          ← {t("household.back")}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold">{household.name}</h2>
        <Badge tone={household.side === "bride" ? "primary" : household.side === "groom" ? "success" : "neutral"}>{t(`sides.${household.side}`)}</Badge>
      </div>
      {created && <Alert tone="success">{t("household.created")}</Alert>}

      {/* Guest link (GST-06) */}
      <Card>
        <CardTitle>{t("guestLink.title")}</CardTitle>
        <p className="mb-3 text-sm text-muted">{t("guestLink.help")}</p>
        {household.linkRevokedAt ? (
          <Alert tone="warning">{t("guestLink.revoked")}</Alert>
        ) : (
          <>
            <p className="mb-3 break-all rounded-lg bg-surface-muted px-3 py-2 font-mono text-sm" data-testid="guest-link">
              {link}
            </p>
            <div className="mb-3 flex flex-wrap gap-2">
              <CopyButton text={link} label={t("guestLink.copy")} copiedLabel={t("guestLink.copied")} variant="primary" />
              <a
                href={whatsappShareUrl(head?.phone ?? null, guestLinkMessage(household.locale, ctx.event.name, household.name, link))}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonClass("secondary")}
              >
                {t("guestLink.whatsapp")}
              </a>
            </div>
            {canEdit &&
              (contacts.length ? (
                <SimpleForm action={sendGuestLinkAction.bind(null, eventId, householdId)} className="flex flex-wrap items-end gap-2">
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">{t("guestLink.sendBy")}</span>
                    <Select name="target" className="w-auto">
                      {contacts.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <SubmitButton variant="secondary">{t("guestLink.send")}</SubmitButton>
                </SimpleForm>
              ) : (
                <p className="text-sm text-muted">{t("guestLink.noContact")}</p>
              ))}
            {household.linkSentAt && <p className="mt-2 text-xs text-muted">{t("guestLink.lastSent", { date: formatDateTime(locale, household.linkSentAt) })}</p>}
          </>
        )}
        {canEdit && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
            <ConfirmForm action={regenerateLinkAction.bind(null, eventId, householdId)} label={t("guestLink.regenerate")} confirm={t("guestLink.regenerateConfirm")} />
            {!household.linkRevokedAt && (
              <ConfirmForm action={revokeLinkAction.bind(null, eventId, householdId)} label={t("guestLink.revoke")} confirm={t("guestLink.revokeConfirm")} tone="danger" />
            )}
          </div>
        )}
        {canEdit && (
          <SimpleForm action={familySettingsAction.bind(null, eventId, householdId)} className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label={t("guestLink.language")} htmlFor="family-locale">
              <Select id="family-locale" name="locale" defaultValue={household.locale}>
                <option value="en">English</option>
                <option value="hi">हिन्दी</option>
              </Select>
            </Field>
            <Field label={t("guestLink.plusOnes")} htmlFor="plusOnesAllowed">
              <Input id="plusOnesAllowed" name="plusOnesAllowed" type="number" min={0} max={10} defaultValue={household.plusOnesAllowed} />
            </Field>
            <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>
          </SimpleForm>
        )}
      </Card>

      {/* Broadcast opt-out (DPDP): a family that replied STOP or asked not to get updates */}
      <Card>
        <CardTitle>{t("household.broadcastsTitle")}</CardTitle>
        {!optOut.hasContacts ? (
          <p className="text-sm text-muted">{t("household.broadcastsNoContact")}</p>
        ) : (
          <>
            {optOut.optedOut ? (
              <Alert tone="warning">{t("household.broadcastsOff", { channels: optOut.channels.map((c) => t(`thankYous.channels.${c}`)).join(", ") })}</Alert>
            ) : (
              <p className="text-sm">{t("household.broadcastsOn")}</p>
            )}
            <p className="mt-2 text-sm text-muted">{t("household.broadcastsHelp")}</p>
            {canEdit && (
              <div className="mt-3 flex flex-wrap gap-2">
                {optOut.optedOut ? (
                  <ConfirmForm action={broadcastOptOutAction.bind(null, eventId, householdId, false)} label={t("household.resumeBroadcasts")} confirm={t("household.resumeBroadcastsConfirm")} />
                ) : (
                  <ConfirmForm action={broadcastOptOutAction.bind(null, eventId, householdId, true)} label={t("household.stopBroadcasts")} confirm={t("household.stopBroadcastsConfirm")} />
                )}
              </div>
            )}
          </>
        )}
      </Card>

      {/* Invitations matrix */}
      <Card>
        <CardTitle>{t("household.invites")}</CardTitle>
        {fns.length === 0 ? (
          <p className="text-sm text-muted">{t("guests.noFunctionsYet")}</p>
        ) : (
          <SimpleForm action={saveInvitesAction.bind(null, eventId, householdId)} className="space-y-3">
            <p className="text-sm text-muted">{t("household.invitesHelp")}</p>
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
                <thead>
                  <tr>
                    <th className="sticky left-0 bg-surface py-2 pr-3 text-left font-medium" scope="col">
                      {t("household.members")}
                    </th>
                    {fns.map((fn) => (
                      <th key={fn.id} className="px-2 py-2 text-center font-medium" scope="col">
                        {fn.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {household.members.map((m) => (
                    <tr key={m.id} className="border-t border-border">
                      <th scope="row" className="sticky left-0 border-t border-border bg-surface py-2 pr-3 text-left font-normal">
                        <input type="hidden" name="guestIds" value={m.id} />
                        {m.name}
                      </th>
                      {fns.map((fn) => (
                        <td key={fn.id} className="border-t border-border px-2 py-1 text-center">
                          <label className="inline-flex min-h-11 min-w-11 items-center justify-center">
                            <span className="sr-only">
                              {m.name} – {fn.name}
                            </span>
                            <input type="checkbox" name={`inv:${m.id}:${fn.id}`} defaultChecked={m.functionIds.includes(fn.id)} disabled={!canEdit} className="h-5 w-5" />
                          </label>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canEdit && <SubmitButton>{t("household.saveInvites")}</SubmitButton>}
          </SimpleForm>
        )}
      </Card>

      {/* RSVP on the family's behalf (RSV-04) */}
      {portal.functions.length > 0 && (
        <Card>
          <CardTitle>{t("rsvp.title")}</CardTitle>
          <p className="mb-3 text-sm text-muted">{t("rsvp.recordHelp")}</p>
          <SimpleForm action={recordRsvpAction.bind(null, eventId, householdId)} className="space-y-3">
            <div className="-mx-4 overflow-x-auto px-4">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr>
                    <th className="py-2 pr-3 text-left font-medium" scope="col">{t("household.members")}</th>
                    {portal.functions.map((fn) => (
                      <th key={fn.id} className="px-2 py-2 text-left font-medium" scope="col">{fn.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {portal.members.map((m) => (
                    <tr key={m.id} className="border-t border-border">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">{m.name}</th>
                      {portal.functions.map((fn) => (
                        <td key={fn.id} className="px-2 py-1">
                          {m.functionIds.includes(fn.id) ? (
                            <Select
                              name={`rsvp:${m.id}:${fn.id}`}
                              defaultValue={m.rsvp[fn.id] ?? ""}
                              aria-label={`${m.name} – ${fn.name}`}
                              disabled={!canEdit}
                              className="min-h-10 w-auto text-sm"
                            >
                              <option value="">{t("rsvp.pending")}</option>
                              <option value="attending">{t("rsvp.attending")}</option>
                              <option value="maybe">{t("rsvp.maybe")}</option>
                              <option value="declined">{t("rsvp.declined")}</option>
                            </Select>
                          ) : (
                            <span className="text-muted">{t("rsvp.notInvited")}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canEdit && <SubmitButton>{t("rsvp.save")}</SubmitButton>}
          </SimpleForm>
        </Card>
      )}

      {/* Members */}
      <Card>
        <CardTitle>{t("household.members")}</CardTitle>
        <ul className="divide-y divide-border">
          {household.members.map((m) => (
            <li key={m.id} className="py-3 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{m.name}</span>
                {m.isHead && <Badge tone="primary">{t("guests.head")}</Badge>}
                {m.ageGroup !== "adult" && <Badge>{t(`ages.${m.ageGroup}`)}</Badge>}
                {m.diet && <Badge tone="success">{m.diet === "other" && m.dietNotes ? m.dietNotes : t(`diets.${m.diet}`)}</Badge>}
                {m.tags.map((tag) => (
                  <Badge key={tag} tone="warning">
                    {tag}
                  </Badge>
                ))}
              </div>
              <p className="text-sm text-muted">{[m.relation, formatPhone(m.phone), m.email].filter(Boolean).join(" · ")}</p>
              {hasTravel(travel.get(m.id)) && (
                <p className="mt-1 text-sm">
                  {travelSummary(t, locale, travel.get(m.id)!)}
                  {travel.get(m.id)!.needsPickup && <> · <Badge tone="warning">{t("travel.needsPickup")}</Badge></>}
                  {travel.get(m.id)!.needsDrop && <> · <Badge tone="warning">{t("travel.needsDrop")}</Badge></>}
                  {travel.get(m.id)!.updatedByGuest && <span className="text-muted"> ({t("travel.byGuest")})</span>}
                </p>
              )}
              {canEdit && (
                <details className="mt-2">
                  <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">{t("guestForm.edit")}</summary>
                  <div className="mt-2 space-y-3 rounded-lg border border-border p-3">
                    <SimpleForm action={updateGuestAction.bind(null, eventId, m.id)}>
                      <GuestFields labels={labels} prefix="g_" idBase={`g${m.id}_`} guest={m} />
                      <SubmitButton>{t("common.save")}</SubmitButton>
                    </SimpleForm>
                    <details className="border-t border-border pt-3">
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-primary">{t("travel.title")}</summary>
                      <SimpleForm action={saveTravelAction.bind(null, eventId, m.id)} className="mt-2 space-y-3">
                        <TravelFields labels={travelLabels(t)} travel={travel.get(m.id)} idBase={`t${m.id}_`} />
                        <SubmitButton variant="secondary">{t("travel.save")}</SubmitButton>
                      </SimpleForm>
                    </details>
                    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                      {!m.isHead && (
                        <form action={setHeadAction.bind(null, eventId, m.id)}>
                          <SubmitButton variant="secondary">{t("household.makeHead")}</SubmitButton>
                        </form>
                      )}
                      <SimpleForm action={removeGuestAction.bind(null, eventId, m.id)} className="space-y-2">
                        <SubmitButton variant="ghost" className="text-danger">
                          {t("household.removeMember")}
                        </SubmitButton>
                      </SimpleForm>
                    </div>
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <details className="mt-3 border-t border-border pt-3">
            <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-primary">+ {t("household.addMember")}</summary>
            <SimpleForm action={addGuestAction.bind(null, eventId, householdId)} className="mt-2 space-y-3">
              <GuestFields labels={labels} prefix="new_" />
              <SubmitButton>{t("household.addMember")}</SubmitButton>
            </SimpleForm>
          </details>
        )}
      </Card>

      {/* Family details */}
      <Card>
        <CardTitle>{t("household.details")}</CardTitle>
        <SimpleForm action={updateHouseholdAction.bind(null, eventId, householdId)}>
          <fieldset disabled={!canEdit} className="space-y-3">
            <HouseholdFields labels={householdFieldLabels(t)} household={household} />
          </fieldset>
          {canEdit && <SubmitButton>{t("common.save")}</SubmitButton>}
        </SimpleForm>
      </Card>

      {canEdit && (
        <Card>
          <CardTitle>{t("household.delete")}</CardTitle>
          <p className="mb-3 text-sm text-muted">{t("household.deleteConfirm")}</p>
          <form action={deleteHouseholdAction.bind(null, eventId, householdId)}>
            <ConfirmButton variant="danger" confirm={t("household.deleteConfirm")}>{t("household.delete")}</ConfirmButton>
          </form>
        </Card>
      )}
    </div>
  );
}
