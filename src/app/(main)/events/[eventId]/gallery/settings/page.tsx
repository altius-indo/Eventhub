import { notFound } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, Field, Input, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { intlLocale } from "@/i18n/core";
import { formatBytes, getGallerySettings } from "@/lib/gallery";
import { getStorageLimits } from "@/lib/storage-quota";
import { getEventContext } from "@/lib/server/event-context";
import { getTranslator } from "@/lib/server/session";
import { saveSettingsAction } from "../actions";

/** Guest uploads, moderation, downloads, reactions and watermark switches (GAL-03/04/06/08/10). */
export default async function GallerySettingsPage({ params }: PageProps<"/events/[eventId]/gallery/settings">) {
  const { eventId } = await params;
  const ctx = await getEventContext(eventId);
  if (!ctx.can("gallery.moderate")) notFound();
  const { t, locale } = await getTranslator();
  const db = getDb();
  const [s, limits] = await Promise.all([getGallerySettings(db, eventId), getStorageLimits(db, eventId)]);
  const toggle = (name: "guestUploads" | "autoApprove" | "guestOriginals" | "reactions", help: string) => (
    <label className="flex min-h-11 items-start gap-3">
      <input type="checkbox" name={name} defaultChecked={s[name]} className="mt-1 h-5 w-5 shrink-0" />
      <span>
        <span className="block font-medium">{t(`gallery.settings.${name}`)}</span>
        <span className="block text-sm text-muted">{help}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-4">
      <PageHeader title={t("gallery.settings.title")} />
      <Card>
        <SimpleForm action={saveSettingsAction.bind(null, eventId)} className="space-y-4">
          {toggle("guestUploads", t("gallery.settings.guestUploadsHelp", { items: limits.guestItems, size: formatBytes(intlLocale(locale), limits.guestBytes) }))}
          {toggle("autoApprove", t("gallery.settings.autoApproveHelp"))}
          {toggle("guestOriginals", t("gallery.settings.guestOriginalsHelp"))}
          {toggle("reactions", t("gallery.settings.reactionsHelp"))}
          <Field label={t("gallery.settings.watermark")} htmlFor="watermarkText" hint={t("gallery.settings.watermarkHelp")}>
            <Input id="watermarkText" name="watermarkText" defaultValue={s.watermarkText ?? ""} maxLength={60} />
          </Field>
          <SubmitButton>{t("gallery.settings.save")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
