import { notFound } from "next/navigation";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { isUuid } from "@/lib/ids";
import { revealVendorSecrets, VendorError } from "@/lib/vendors";
import { getEventContext } from "@/lib/server/event-context";
import { requireStepUp, getTranslator } from "@/lib/server/session";

/** Full PAN and bank details, only after a fresh one-time code (EVT-01d); each view is audited. */
export default async function VendorBankPage({ params }: PageProps<"/events/[eventId]/vendors/[vendorId]/bank">) {
  const { eventId, vendorId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("vendors.bank_view") || !isUuid(vendorId)) notFound();
  await requireStepUp(ctx, `/events/${eventId}/vendors/${vendorId}/bank`);
  const { t } = await getTranslator();
  const s = await revealVendorSecrets(getDb(), eventId, vendorId, ctx.actor).catch((e) => {
    if (e instanceof VendorError) notFound();
    throw e;
  });
  const rows: [string, string | null | undefined][] = [
    [t("vendors.pan"), s.pan],
    [t("vendors.accountName"), s.bank?.accountName],
    [t("vendors.accountNumber"), s.bank?.accountNumber],
    [t("vendors.ifsc"), s.bank?.ifsc],
    [t("vendors.upi"), s.bank?.upi],
  ];
  return (
    <div className="max-w-lg space-y-4">
      <PageHeader title={t("vendors.bank")} />
      <Card>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-sm text-muted">{k}</dt>
              <dd className="font-mono break-all">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <LinkButton href={`/events/${eventId}/vendors/${vendorId}`} variant="secondary">
        {t("vendors.hide")}
      </LinkButton>
    </div>
  );
}
