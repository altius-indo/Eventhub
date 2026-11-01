import { notFound } from "next/navigation";
import { EnvelopeDesk, type EnvelopeLabels } from "@/components/envelope-desk";
import { PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { getFunction, NotFoundError } from "@/lib/functions";
import { GIFT_TYPES, RECEIVED_FOR } from "@/lib/gifts";
import { isUuid } from "@/lib/ids";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { forLabel, typeLabel } from "../../shared";

export default async function EnvelopePage({ params }: PageProps<"/events/[eventId]/gifts/envelope/[functionId]">) {
  const { eventId, functionId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gifts.record") || !isUuid(functionId)) notFound();
  const fn = await getFunction(getDb(), eventId, functionId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { t, locale } = await getTranslator();
  const keys = [
    "giver", "unknownGiver", "unknownName", "change", "amount", "envelopeNo", "type", "item", "receivedFor", "save", "saved", "savedNext",
    "pending", "rejected", "duplicate", "recent", "myOpen", "entries", "noGiver", "noValue",
  ] as const;
  const labels: EnvelopeLabels = {
    ...(Object.fromEntries(keys.map((k) => [k, t(`gifts.envelope.${k}`, { count: "{count}", no: "{no}" })])) as Record<(typeof keys)[number], string>),
    scan: t("gifts.envelope.scan"),
    stopScan: t("checkin.stopScan"),
    scanHelp: t("checkin.scanHelp"),
    cameraUnavailable: t("checkin.cameraUnavailable"),
    search: t("checkin.search"),
    searchButton: t("checkin.searchButton"),
    noResults: t("checkin.noResults"),
    offline: t("checkin.offline"),
    signInAgain: t("checkin.signInAgain"),
    logIn: t("checkin.logIn"),
    invalidPass: t("checkin.invalidPass"),
    wrongEvent: t("checkin.wrongEvent"),
    somethingWrong: t("common.somethingWrong"),
    erased: t("gifts.erasedGiver"),
    types: Object.fromEntries(GIFT_TYPES.map((k) => [k, typeLabel(t, k)])) as EnvelopeLabels["types"],
    fors: Object.fromEntries(RECEIVED_FOR.map((k) => [k, forLabel(t, k)])) as EnvelopeLabels["fors"],
    rejectCodes: {
      invalid: t("gifts.errors.invalid"),
      no_giver: t("gifts.errors.no_giver"),
      no_value: t("gifts.errors.no_value"),
      bad_household: t("gifts.errors.bad_household"),
      bad_guest: t("gifts.errors.bad_guest"),
    },
  };
  return (
    <div>
      <PageHeader title={`${t("gifts.envelope.title")} · ${fn.name}`} subtitle={t("gifts.envelope.help")} />
      <EnvelopeDesk apiUrl={`/events/${eventId}/gifts/envelope/${functionId}/api`} functionId={functionId} userId={ctx.actor.userId} locale={locale} timeZone={ctx.event.timezone} labels={labels} />
    </div>
  );
}
