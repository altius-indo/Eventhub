import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageHeader } from "@/components/ui";
import { VendorFields } from "@/components/vendor-fields";
import { getDb } from "@/db";
import { listServiceTypes } from "@/lib/catalogue";
import { getEventContext } from "@/lib/server/event-context";
import { typeLabel, vendorLabels } from "@/lib/server/money-form";
import { getTranslator } from "@/lib/server/session";
import { createVendorAction } from "../actions";

export default async function NewVendorPage({ params }: PageProps<"/events/[eventId]/vendors/new">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("vendors.edit")) notFound();
  const { t } = await getTranslator();
  const types = await listServiceTypes(getDb(), eventId, "service");
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={t("vendors.add")} />
      <Card>
        <SimpleForm action={createVendorAction.bind(null, eventId)}>
          <VendorFields labels={vendorLabels(t)} types={types.map((ty) => ({ id: ty.id, label: typeLabel(t, { typeKey: ty.systemKey, typeName: ty.name }) }))} />
          <SubmitButton>{t("vendors.add")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
