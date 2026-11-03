import { Card, CardTitle } from "@/components/ui";
import type { DocumentRow } from "@/db/schema";
import type { Translator } from "@/i18n/core";

/** Files the vendor can download (read-only list; downloads go through the portal's own route). */
export function PortalDocuments({ vendorId, docs, title, t }: { vendorId: string; docs: DocumentRow[]; title: string; t: Translator }) {
  const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {docs.length === 0 ? (
        <p className="text-sm text-muted">{t("documents.empty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-1">
              <a href={`/vendor/${vendorId}/documents/${d.id}`} className="min-h-11 min-w-0 flex-1 break-all py-2 text-primary underline">
                {d.filename}
              </a>
              <span className="text-sm text-muted">
                {t(`documents.kinds.${d.kind}`)} · {kb(d.bytes)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
