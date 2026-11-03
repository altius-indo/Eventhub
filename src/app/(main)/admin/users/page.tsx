import { desc, eq, ilike, inArray, or } from "drizzle-orm";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, Input } from "@/components/ui";
import { getDb } from "@/db";
import { userIdentifiers, users } from "@/db/schema";
import { formatDate } from "@/i18n/core";
import { listIdentifiers } from "@/lib/auth-core";
import { formatIdentifier, parseIdentifier } from "@/lib/identifiers";
import { getTranslator, requireAppAdmin } from "@/lib/server/session";
import { adminUserAction } from "./actions";

export default async function AdminUsersPage({ searchParams }: PageProps<"/admin/users">) {
  const { user: me } = await requireAppAdmin();
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";
  const { t, locale } = await getTranslator();
  const db = getDb();

  let where = undefined;
  if (query) {
    const asIdentifier = parseIdentifier(query);
    const pattern = `%${query.replace(/[%_]/g, "\\$&")}%`;
    const idMatches = db
      .select({ id: userIdentifiers.userId })
      .from(userIdentifiers)
      .where(or(ilike(userIdentifiers.value, pattern), asIdentifier ? eq(userIdentifiers.value, asIdentifier.value) : undefined));
    where = or(ilike(users.name, pattern), inArray(users.id, idMatches));
  }
  const rows = await db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(100);
  const identifiers = await listIdentifiers(db, rows.map((r) => r.id));

  return (
    <div className="space-y-4">
      <form className="flex gap-2" role="search">
        <Input name="q" defaultValue={query} placeholder={t("admin.search")} aria-label={t("admin.search")} />
        <button type="submit" className="min-h-11 rounded-lg border border-border bg-surface px-4 text-sm">
          {t("admin.searchButton")}
        </button>
      </form>
      <Card>
        {rows.length === 0 ? (
          <p className="text-muted">{t("admin.noResults")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((u) => (
              <li key={u.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {u.name ?? "—"}
                    {u.isAppAdmin && <Badge tone="primary">{t("admin.adminBadge")}</Badge>}
                    {u.suspendedAt && <Badge tone="danger">{t("admin.suspended")}</Badge>}
                  </p>
                  <p className="break-all text-sm text-muted">
                    {identifiers.filter((i) => i.userId === u.id).map(formatIdentifier).join(" · ")}
                  </p>
                  <p className="text-xs text-muted">{t("admin.createdOn", { date: formatDate(locale, u.createdAt) })}</p>
                </div>
                {u.id !== me.id && (
                  <SimpleForm action={adminUserAction} className="flex flex-wrap gap-2">
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="q" value={query} />
                    {u.suspendedAt ? (
                      <SubmitButton name="op" value="reactivate" variant="secondary" className="min-h-10">
                        {t("admin.reactivate")}
                      </SubmitButton>
                    ) : (
                      <SubmitButton name="op" value="suspend" variant="secondary" className="min-h-10 text-danger">
                        {t("admin.suspend")}
                      </SubmitButton>
                    )}
                    <SubmitButton name="op" value={u.isAppAdmin ? "revoke_admin" : "grant_admin"} variant="ghost" className="min-h-10">
                      {u.isAppAdmin ? t("admin.removeAdmin") : t("admin.makeAdmin")}
                    </SubmitButton>
                  </SimpleForm>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
