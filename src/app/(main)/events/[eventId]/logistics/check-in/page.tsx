import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatTime } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { todayIn } from "@/lib/tasks";

export default async function CheckInChooser({ params, searchParams }: PageProps<"/events/[eventId]/logistics/check-in">) {
  const { eventId } = await params;
  const { pass } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("checkin.operate")) notFound();
  const { t, locale } = await getTranslator();
  const fns = await listFunctions(getDb(), eventId);
  const today = todayIn(ctx.event.timezone);
  const todays = fns.filter((f) => f.date === today);
  const q = typeof pass === "string" && /^[A-Za-z0-9_-]{44}$/.test(pass) ? `?pass=${pass}` : "";
  // Only one function today: go straight there (e.g. after scanning a pass with the phone camera).
  if (todays.length === 1 && q) redirect(`/events/${eventId}/logistics/check-in/${todays[0].id}${q}`);
  return (
    <div>
      <PageHeader title={t("checkin.title")} subtitle={t("checkin.chooseFunction")} />
      <ul className="grid gap-3 sm:grid-cols-2">
        {fns.map((f) => (
          <li key={f.id}>
            <Link
              href={`/events/${eventId}/logistics/check-in/${f.id}${q}`}
              className={`block rounded-xl border bg-surface p-4 hover:border-primary ${f.date === today ? "border-primary" : "border-border"}`}
            >
              <p className="font-semibold">{f.name}</p>
              <p className="text-sm text-muted">{[f.date && formatDay(locale, f.date, { weekday: "short", day: "numeric", month: "short" }), f.startTime && formatTime(locale, f.startTime)].filter(Boolean).join(" · ")}</p>
            </Link>
          </li>
        ))}
      </ul>
      {fns.length === 0 && (
        <Card>
          <p className="text-muted">{t("schedule.empty")}</p>
        </Card>
      )}
    </div>
  );
}
