import type { Broadcast } from "@/db/schema";
import type { Translator } from "@/i18n/core";
import { Field, Input, Textarea } from "./ui";

type Options = { tags: string[]; functions: { id: string; name: string }[]; hotels: { id: string; name: string }[] };

function Checks({ legend, name, items, selected, empty }: { legend: string; name: string; items: { value: string; label: string }[]; selected: string[]; empty: string }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {items.length === 0 && <p className="text-sm text-muted">{empty}</p>}
      <div className="flex flex-wrap gap-x-4">
        {items.map((i) => (
          <label key={i.value} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name={name} value={i.value} defaultChecked={selected.includes(i.value)} className="size-5" />
            <span className="break-words">{i.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Title, texts, channels and segment for a broadcast draft (MSG-02). */
export function BroadcastFields({ t, options, draft }: { t: Translator; options: Options; draft?: Broadcast }) {
  const s = draft?.segment ?? {};
  return (
    <div className="space-y-4">
      <Field label={t("broadcasts.titleLabel")} htmlFor="b-title" hint={t("broadcasts.titleHelp")}>
        <Input id="b-title" name="title" required maxLength={120} defaultValue={draft?.title ?? ""} />
      </Field>
      <Field label={t("broadcasts.bodyEn")} htmlFor="b-en">
        <Textarea id="b-en" name="bodyEn" required maxLength={1000} rows={4} defaultValue={draft?.body.en ?? ""} />
      </Field>
      <Field label={t("broadcasts.bodyHi")} htmlFor="b-hi" hint={t("broadcasts.bodyHiHelp")}>
        <Textarea id="b-hi" name="bodyHi" maxLength={1000} rows={4} lang="hi" defaultValue={draft?.body.hi ?? ""} />
      </Field>
      <div className="space-y-1">
        <Checks
          legend={t("broadcasts.channels")}
          name="channels"
          items={(["whatsapp", "email", "sms"] as const).map((c) => ({ value: c, label: t(`broadcasts.channelNames.${c}`) }))}
          selected={draft?.channels ?? ["whatsapp", "email", "sms"]}
          empty=""
        />
        <p className="text-sm text-muted">{t("broadcasts.channelsHelp")}</p>
      </div>
      <fieldset className="space-y-4 rounded-lg border border-border p-3">
        <legend className="px-1 text-base font-semibold">{t("broadcasts.segment")}</legend>
        <p className="text-sm text-muted">{t("broadcasts.segmentHelp")}</p>
        <Checks
          legend={t("broadcasts.sides")}
          name="sides"
          items={(["bride", "groom", "both"] as const).map((v) => ({ value: v, label: t(`sides.${v}`) }))}
          selected={s.sides ?? []}
          empty=""
        />
        <Checks legend={t("broadcasts.tags")} name="tags" items={options.tags.map((v) => ({ value: v, label: v }))} selected={s.tags ?? []} empty={t("broadcasts.noOptions")} />
        <Checks
          legend={t("broadcasts.functions")}
          name="functionIds"
          items={options.functions.map((f) => ({ value: f.id, label: f.name }))}
          selected={s.functionIds ?? []}
          empty={t("broadcasts.noOptions")}
        />
        <Checks
          legend={t("broadcasts.rsvp")}
          name="rsvp"
          items={(["attending", "maybe", "declined", "pending"] as const).map((v) => ({ value: v, label: t(`broadcasts.rsvpStatus.${v}`) }))}
          selected={s.rsvp ?? []}
          empty=""
        />
        <Checks
          legend={t("broadcasts.travel")}
          name="travel"
          items={(["needs_pickup", "self", "none"] as const).map((v) => ({ value: v, label: t(`broadcasts.travelStatus.${v}`) }))}
          selected={s.travel ?? []}
          empty=""
        />
        <Checks legend={t("broadcasts.hotels")} name="hotelIds" items={options.hotels.map((h) => ({ value: h.id, label: h.name }))} selected={s.hotelIds ?? []} empty={t("broadcasts.noOptions")} />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" name="allAdults" defaultChecked={!!s.allAdults} className="size-5" />
          {t("broadcasts.allAdults")}
        </label>
      </fieldset>
    </div>
  );
}
