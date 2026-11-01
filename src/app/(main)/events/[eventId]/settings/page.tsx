import { EventForm } from "@/components/event-form";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, CardTitle, Field, Input } from "@/components/ui";
import { eventFormLabels } from "@/lib/server/event-form";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { deleteEventAction, updateEventAction, updateRsvpDeadlineAction } from "./actions";

export default async function SettingsPage({ params }: PageProps<"/events/[eventId]/settings">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  const { t } = await getTranslator();
  const canEdit = ctx.can("event.update");

  return (
    <div className="max-w-xl space-y-4">
      <Card>
        <CardTitle>{t("settings.title")}</CardTitle>
        {!canEdit && (
          <div className="mb-4">
            <Alert>{t("settings.readOnly")}</Alert>
          </div>
        )}
        <EventForm
          action={updateEventAction.bind(null, eventId)}
          labels={eventFormLabels(t, t("common.save"))}
          event={ctx.event}
          disabled={!canEdit}
        />
      </Card>

      <Card>
        <CardTitle>{t("rsvp.deadline")}</CardTitle>
        <SimpleForm action={updateRsvpDeadlineAction.bind(null, eventId)} className="space-y-3">
          <Field label={t("rsvp.deadline")} htmlFor="rsvpDeadline" hint={t("rsvp.deadlineHelp")}>
            <Input id="rsvpDeadline" name="rsvpDeadline" type="date" defaultValue={ctx.event.rsvpDeadline ?? ""} disabled={!canEdit} className="sm:w-1/2" />
          </Field>
          {canEdit && <SubmitButton variant="secondary">{t("common.save")}</SubmitButton>}
        </SimpleForm>
      </Card>

      {ctx.can("event.delete") && (
        <Card className="border-danger/40">
          <CardTitle>{t("settings.danger")}</CardTitle>
          <p className="mb-4 text-sm text-muted">{t("settings.deleteHelp")}</p>
          <SimpleForm action={deleteEventAction.bind(null, eventId)}>
            <Field label={t("settings.deleteConfirm")} htmlFor="confirm" hint={ctx.event.name}>
              <Input id="confirm" name="confirm" autoComplete="off" required />
            </Field>
            <SubmitButton variant="danger">{t("settings.deleteButton")}</SubmitButton>
          </SimpleForm>
        </Card>
      )}
    </div>
  );
}
