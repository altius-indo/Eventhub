import { notFound } from "next/navigation";
import { HouseholdCreateForm } from "@/components/household-create-form";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { guestFieldLabels } from "@/lib/server/guest-form";
import { householdFieldLabels } from "@/lib/server/household-labels";
import { getTranslator } from "@/lib/server/session";
import { createHouseholdAction } from "../actions";

export default async function NewHouseholdPage({ params }: PageProps<"/events/[eventId]/guests/new">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("guests.edit")) notFound();
  const { t } = await getTranslator();
  const fns = await listFunctions(getDb(), eventId);
  return (
    <div className="max-w-3xl">
      <PageHeader title={t("household.newTitle")} />
      <HouseholdCreateForm
        action={createHouseholdAction.bind(null, eventId)}
        householdLabels={householdFieldLabels(t)}
        guestLabels={guestFieldLabels(t)}
        functions={fns.map((f) => ({ id: f.id, name: f.name }))}
        labels={{
          details: t("household.details"),
          members: t("household.members"),
          addMember: t("household.addMember"),
          remove: t("household.removeMember"),
          inviteAll: t("household.inviteAll"),
          submit: t("household.newTitle"),
          head: t("guests.head"),
        }}
      />
    </div>
  );
}
