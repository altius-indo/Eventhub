import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { formatDay, formatTime } from "@/i18n/core";
import { listFunctions } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { todayIn } from "@/lib/tasks";

/** Envelope mode (GFT-02): pick the function you are collecting shagun at. */
export default async function EnvelopeChooser({ params, searchParams }: PageProps<"/events/[eventId]/gifts/envelope">) {
  const { eventId } = await params;
  const { go } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record")) notFound();
  const { t, locale } = await getTranslator();
  const fns = await listFunctions(getDb(), eventId);
  const today = todayIn(ctx.event.timezone);
  const todays = fns.filter((f) => f.date === today);
  if (todays.length === 1 && go === "today") redirect(`/events/${eventId}/gifts/envelope/${todays[0].id}`);
  return (
    <div>
      <PageHeader title={t("gifts.envelope.title")} subtitle={t("gifts.envelope.choose")} />
      <ul className="grid gap-3 sm:grid-cols-2">
        {fns.map((f) => (
          <li key={f.id}>
            <Link
              href={`/events/${eventId}/gifts/envelope/${f.id}`}
              className={`block min-h-11 rounded-xl border bg-surface p-4 hover:border-primary ${f.date === today ? "border-primary" : "border-border"}`}
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
