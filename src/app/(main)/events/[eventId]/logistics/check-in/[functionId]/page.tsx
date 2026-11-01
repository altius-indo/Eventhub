import { notFound } from "next/navigation";
import { CheckInDesk, type DeskLabels } from "@/components/check-in-desk";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { getFunction, NotFoundError } from "@/lib/functions";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { isUuid } from "@/lib/ids";

export default async function CheckInPage({ params, searchParams }: PageProps<"/events/[eventId]/logistics/check-in/[functionId]">) {
  const { eventId, functionId } = await params;
  const { pass } = await searchParams;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("checkin.operate") || !isUuid(functionId)) notFound();
  const fn = await getFunction(getDb(), eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { t, locale } = await getTranslator();
  const keys = [
    "scan", "stopScan", "scanHelp", "cameraUnavailable", "search", "searchButton", "noResults", "markArrived", "arrivedAt", "by",
    "notInvited", "declined", "undo", "walkIn", "walkInName", "walkInCount", "walkInAdd", "expected", "arrived", "maybe", "noReply",
    "walkIns", "uninvited", "recent", "pending", "retrying", "saved", "allowUninvited", "invalidPass", "wrongEvent", "offline",
    "signInAgain", "legacyPass", "rejected", "logIn", "offlineCopy",
  ] as const;
  const labels = {
    ...Object.fromEntries(keys.map((k) => [k, t(`checkin.${k}`, { time: "{time}", name: "{name}", count: "{count}" })])),
    bride: t("sides.bride"),
    groom: t("sides.groom"),
    both: t("sides.both"),
    adult: t("ages.adult"),
    child: t("ages.child"),
    infant: t("ages.infant"),
    somethingWrong: t("common.somethingWrong"),
  } as DeskLabels;
  return (
    <div>
      <PageHeader title={`${t("checkin.title")} · ${fn.name}`} />
      <CheckInDesk
        apiUrl={`/events/${eventId}/logistics/check-in/${functionId}/api`}
        functionId={functionId}
        userId={ctx.actor.userId}
        timeZone={ctx.event.timezone}
        locale={locale}
        labels={labels}
        initialPass={typeof pass === "string" && /^[A-Za-z0-9_-]{44}$/.test(pass) ? pass : undefined}
      />
    </div>
  );
}
