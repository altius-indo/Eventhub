import { SubNav } from "@/components/sub-nav";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function BudgetLayout({ children, params }: LayoutProps<"/events/[eventId]/budget">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t } = await getTranslator();
  const base = `/events/${eventId}/budget`;
  return (
    <div>
      <SubNav
        label={t("budget.title")}
        links={[
          { href: base, label: t("budget.overview") },
          { href: `${base}/lines`, label: t("budget.lines") },
          { href: `${base}/payables`, label: t("budget.payables") },
          { href: `${base}/invoices`, label: t("budget.invoices") },
          { href: `${base}/settings`, label: t("budget.settings") },
        ]}
      />
      {children}
    </div>
  );
}
