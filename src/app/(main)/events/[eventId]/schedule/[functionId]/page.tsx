import { notFound } from "next/navigation";
import { FunctionForm } from "@/components/function-form";
import { ConfirmButton } from "@/components/confirm-button";
import { Alert, Card, CardTitle, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { getFunction, NotFoundError } from "@/lib/functions";
import { functionFormLabels } from "@/lib/server/function-form";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { deleteFunctionAction, updateFunctionAction } from "../actions";
import { isUuid } from "@/lib/ids";

export default async function EditFunctionPage({ params, searchParams }: PageProps<"/events/[eventId]/schedule/[functionId]">) {
  const { eventId, functionId } = await params;
  const { blocked } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("itinerary.edit") || !isUuid(functionId)) notFound();
  const fn = await getFunction(getDb(), eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { t } = await getTranslator();
  return (
    <div className="max-w-xl space-y-4">
      <PageHeader title={t("functionForm.editTitle")} />
      <Card>
        <FunctionForm action={updateFunctionAction.bind(null, eventId, functionId)} labels={functionFormLabels(t, t("common.save"))} fn={fn} />
      </Card>
      <Card>
        <CardTitle>{t("schedule.delete")}</CardTitle>
        <p className="mb-3 text-sm text-muted">{t("schedule.deleteHelp")}</p>
        {blocked && (
          <div className="mb-3">
            <Alert tone="danger">{t("services.errors.has_services")}</Alert>
          </div>
        )}
        <form action={deleteFunctionAction.bind(null, eventId, functionId)}>
          <ConfirmButton variant="danger" confirm={t("schedule.deleteHelp")}>{t("schedule.delete")}</ConfirmButton>
        </form>
      </Card>
    </div>
  );
}
