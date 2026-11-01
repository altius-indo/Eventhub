import { deleteDocumentAction } from "@/app/(main)/events/[eventId]/documents/actions";
import type { DocumentRow } from "@/db/schema";
import { ConfirmButton } from "./confirm-button";
import { Alert, Card, CardTitle, Field, Input, Select, buttonClass } from "./ui";

export type DocumentLabels = {
  title: string;
  upload: string;
  file: string;
  kind: string;
  help: string;
  empty: string;
  remove: string;
  deleteConfirm: string;
  kinds: Record<DocumentRow["kind"], string>;
  error?: string;
  saved?: string;
};

/** Files attached to a vendor, quote, booking, invoice, payment or service. */
export function DocumentsPanel({
  eventId,
  owner,
  ownerId,
  docs,
  canEdit,
  back,
  defaultKind = "other",
  labels,
}: {
  eventId: string;
  owner: "vendorId" | "quoteId" | "bookingId" | "invoiceId" | "paymentId" | "serviceId";
  ownerId: string;
  docs: DocumentRow[];
  canEdit: boolean;
  back: string;
  defaultKind?: DocumentRow["kind"];
  labels: DocumentLabels;
}) {
  const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <Card>
      <CardTitle>{labels.title}</CardTitle>
      {labels.error && (
        <div className="mb-3">
          <Alert tone="danger">{labels.error}</Alert>
        </div>
      )}
      {labels.saved && (
        <div className="mb-3">
          <Alert tone="success">{labels.saved}</Alert>
        </div>
      )}
      {docs.length === 0 ? (
        <p className="text-sm text-muted">{labels.empty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2">
              <a href={`/events/${eventId}/documents/${d.id}`} className="min-h-11 min-w-0 flex-1 break-all py-2 text-primary underline">
                {d.filename}
              </a>
              <span className="text-sm text-muted">
                {labels.kinds[d.kind]} · {kb(d.bytes)}
              </span>
              {canEdit && (
                <form action={deleteDocumentAction.bind(null, eventId, d.id)}>
                  <ConfirmButton variant="ghost" confirm={labels.deleteConfirm}>
                    {labels.remove}
                  </ConfirmButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form action={`/events/${eventId}/documents`} method="post" encType="multipart/form-data" className="mt-3 grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <input type="hidden" name="owner" value={owner} />
          <input type="hidden" name="ownerId" value={ownerId} />
          <input type="hidden" name="back" value={back} />
          <Field label={labels.file} htmlFor={`doc-${ownerId}`} hint={labels.help}>
            <Input id={`doc-${ownerId}`} name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,.heic" className="py-2" />
          </Field>
          <Field label={labels.kind} htmlFor={`kind-${ownerId}`}>
            <Select id={`kind-${ownerId}`} name="kind" defaultValue={defaultKind}>
              {(Object.keys(labels.kinds) as DocumentRow["kind"][]).map((k) => (
                <option key={k} value={k}>
                  {labels.kinds[k]}
                </option>
              ))}
            </Select>
          </Field>
          <button type="submit" className={buttonClass("secondary")}>
            {labels.upload}
          </button>
        </form>
      )}
    </Card>
  );
}
