import { EventForm } from "@/components/event-form";
import { Card, PageHeader } from "@/components/ui";
import { eventFormLabels } from "@/lib/server/event-form";
import { getTranslator, requireUser } from "@/lib/server/session";
import { createEventAction } from "../actions";

export default async function NewEventPage() {
  await requireUser();
  const { t } = await getTranslator();
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t("eventForm.newTitle")} />
      <Card>
        <EventForm action={createEventAction} labels={eventFormLabels(t, t("events.create"))} />
      </Card>
    </div>
  );
}
