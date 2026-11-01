import Link from "next/link";
import { Alert, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { getTranslator, requireAppAdmin } from "@/lib/server/session";
import { STUCK_ATTEMPTS, stuckStorageDeletions } from "@/lib/storage-gc";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAppAdmin();
  const { t } = await getTranslator();
  // Storage deletions that keep failing (EVT-07/09): files that should be gone still exist.
  const stuck = await stuckStorageDeletions(getDb());
  return (
    <div>
      <PageHeader title={t("admin.title")} />
      <nav aria-label="Admin" className="mb-5 flex gap-2 text-sm">
        <Link href="/admin/users" className="rounded-md border border-border bg-surface px-3 py-2 hover:bg-surface-muted">
          {t("admin.users")}
        </Link>
        <Link href="/admin/events" className="rounded-md border border-border bg-surface px-3 py-2 hover:bg-surface-muted">
          {t("admin.events")}
        </Link>
      </nav>
      {stuck > 0 && (
        <div className="mb-5">
          <Alert tone="warning">{t("admin.stuckDeletions", { count: stuck, attempts: STUCK_ATTEMPTS })}</Alert>
        </div>
      )}
      {children}
    </div>
  );
}
