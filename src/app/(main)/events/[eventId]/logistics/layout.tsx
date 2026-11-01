import Link from "next/link";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";

export default async function LogisticsLayout({ children, params }: LayoutProps<"/events/[eventId]/logistics">) {
  const { eventId } = await params;
  await getEventContext(eventId);
  const { t } = await getTranslator();
  const base = `/events/${eventId}/logistics`;
  const links = [
    { href: `${base}/arrivals`, label: t("logistics.arrivals") },
    { href: `${base}/transfers`, label: t("logistics.transfers") },
    { href: `${base}/hotels`, label: t("logistics.hotels") },
    { href: `${base}/check-in`, label: t("logistics.checkIn") },
  ];
  return (
    <div>
      <nav aria-label={t("logistics.title")} className="mb-5 flex flex-wrap gap-2 text-sm print:hidden">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="inline-flex min-h-10 items-center rounded-full border border-border bg-surface px-4 hover:bg-surface-muted">
            {l.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
