import { notFound } from "next/navigation";
import { FunctionForm } from "@/components/function-form";
import { Card, PageHeader } from "@/components/ui";
import { functionFormLabels } from "@/lib/server/function-form";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { createFunctionAction } from "../actions";

export default async function NewFunctionPage({ params }: PageProps<"/events/[eventId]/schedule/new">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("itinerary.edit")) notFound();
  const { t } = await getTranslator();
  return (
    <div className="max-w-xl">
      <PageHeader title={t("functionForm.newTitle")} />
      <Card>
        <FunctionForm
          action={createFunctionAction.bind(null, eventId)}
          labels={functionFormLabels(t, t("schedule.addFunction"))}
          defaultDate={ctx.event.startDate}
        />
      </Card>
    </div>
  );
}
