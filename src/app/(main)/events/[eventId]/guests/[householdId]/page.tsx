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
import {
  addGuestAction,
  deleteHouseholdAction,
  removeGuestAction,
  saveInvitesAction,
  setHeadAction,
  updateGuestAction,
  updateHouseholdAction,
} from "../actions";

export default async function HouseholdPage({ params, searchParams }: PageProps<"/events/[eventId]/guests/[householdId]">) {
  const { eventId, householdId } = await params;
  const { created } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!/^[0-9a-f-]{36}$/i.test(householdId)) notFound();
  const db = getDb();
  const household = await getHouseholdWithMembers(db, eventId, householdId).catch((e) => {
    if (e instanceof GuestError) notFound();
    throw e;
  });
  const fns = await listFunctions(db, eventId);
  const { t } = await getTranslator();
  const canEdit = ctx.can("guests.edit");
  const labels = guestFieldLabels(t);

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
              {canEdit && (
                <details className="mt-2">
                  <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-primary">{t("guestForm.edit")}</summary>
                  <div className="mt-2 space-y-3 rounded-lg border border-border p-3">
                    <SimpleForm action={updateGuestAction.bind(null, eventId, m.id)}>
                      <GuestFields labels={labels} prefix="g_" idBase={`g${m.id}_`} guest={m} />
                      <SubmitButton>{t("common.save")}</SubmitButton>
                    </SimpleForm>
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
