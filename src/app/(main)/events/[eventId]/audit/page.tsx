import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Badge, Card } from "@/components/ui";
import { getDb } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { formatDateTime, translateDynamic } from "@/i18n/core";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function AuditPage({ params }: PageProps<"/events/[eventId]/audit">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("audit.view")) notFound();
  const { t, locale } = await getTranslator();
  const rows = await getDb()
    .select({ log: auditLogs, actorName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(eq(auditLogs.eventId, eventId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(300);

  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold">{t("audit.title")}</h2>
      {rows.length === 0 ? (
        <p className="text-muted">{t("audit.empty")}</p>
      ) : (
        <ol className="divide-y divide-border">
          {rows.map(({ log, actorName }) => {
            const data = (log.data ?? {}) as Record<string, string>;
            const vars = {
              // Erased families (EVT-09) leave rows without a name.
              name: t("audit.erasedName"),
              ...data,
              role: data.role ? t(data.role === "host" ? "roles.host" : "roles.planner") : "",
              kind: data.kind === "pickup" || data.kind === "drop" || data.kind === "shuttle" ? t(`transfers.kinds.${data.kind}`) : (data.kind ?? ""),
            };
            const text = translateDynamic(locale, `audit.actions.${log.action}`, vars) ?? log.action;
            return (
              <li key={log.id} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                <time className="shrink-0 text-xs text-muted sm:w-40" dateTime={log.createdAt.toISOString()}>
                  {formatDateTime(locale, log.createdAt)}
                </time>
                <p className="text-sm">
                  <span className="font-medium">{actorName ?? t("audit.system")}</span> {text}{" "}
                  {log.actorIsAppAdmin && <Badge tone="warning">{t("audit.adminTag")}</Badge>}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
