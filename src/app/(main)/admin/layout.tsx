import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { getTranslator, requireAppAdmin } from "@/lib/server/session";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  await requireAppAdmin();
  const { t } = await getTranslator();
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
      {children}
    </div>
  );
}
