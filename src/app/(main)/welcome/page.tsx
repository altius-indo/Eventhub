import { redirect } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, Field, Input } from "@/components/ui";
import { getTranslator, requireUser, safeNext } from "@/lib/server/session";
import { saveNameAction } from "./actions";

export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  const { user } = await requireUser({ allowUnnamed: true });
  const { next } = await searchParams;
  if (user.name) redirect(safeNext(next));
  const { t } = await getTranslator();
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <Card>
        <h1 className="text-xl font-semibold">{t("onboarding.title")}</h1>
        <p className="mb-5 mt-1 text-sm text-muted">{t("onboarding.subtitle")}</p>
        <SimpleForm action={saveNameAction}>
          <input type="hidden" name="next" value={safeNext(next)} />
          <Field label={t("onboarding.nameLabel")} htmlFor="name">
            <Input id="name" name="name" autoComplete="name" required autoFocus maxLength={80} />
          </Field>
          <SubmitButton className="w-full">{t("common.continue")}</SubmitButton>
        </SimpleForm>
      </Card>
    </div>
  );
}
