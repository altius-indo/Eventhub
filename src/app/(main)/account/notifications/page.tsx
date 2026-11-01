import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { CATEGORIES, getPrefs } from "@/lib/notifications";
import { getTranslator, requireUser } from "@/lib/server/session";
import { savePrefsAction } from "./actions";

export default async function NotificationPrefsPage() {
  const { user } = await requireUser({ allowUnnamed: true });
  const { t } = await getTranslator();
  const prefs = await getPrefs(getDb(), user.id);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/notifications" className="inline-flex min-h-11 items-center text-sm text-primary underline">
        {t("notifications.back")}
      </Link>
      <PageHeader title={t("notifications.prefsTitle")} subtitle={t("notifications.prefsHelp")} />
      <Card>
        <SimpleForm action={savePrefsAction}>
          <fieldset>
            <legend className="sr-only">{t("notifications.prefsTitle")}</legend>
            {CATEGORIES.map((c) => (
              <label key={c} className="flex min-h-11 items-center gap-3 text-sm">
                <input type="checkbox" name={c} defaultChecked={prefs[c]} className="size-5" />
                {t(`notifications.categories.${c}`)}
              </label>
            ))}
          </fieldset>
          <SubmitButton>{t("notifications.prefsSave")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
