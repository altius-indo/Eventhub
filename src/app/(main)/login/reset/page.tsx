import type { Metadata } from "next";
import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, Field, Input } from "@/components/ui";
import { getTranslator } from "@/lib/server/session";
import { requestResetAction } from "../password/actions";

export const metadata: Metadata = { title: "Reset password", robots: { index: false } };

export default async function ResetRequestPage() {
  const { t } = await getTranslator();
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <Card>
        <h1 className="text-xl font-semibold">{t("password.resetTitle")}</h1>
        <p className="mb-5 mt-1 text-sm text-muted">{t("password.resetHelp")}</p>
        <SimpleForm action={requestResetAction}>
          <Field label={t("password.email")} htmlFor="reset-email">
            <Input id="reset-email" name="email" type="email" required autoComplete="username" />
          </Field>
          <SubmitButton className="w-full">{t("password.resetSend")}</SubmitButton>
        </SimpleForm>
        <Link href="/login/password" className="mt-4 inline-flex min-h-11 items-center text-sm text-primary underline">
          {t("common.back")}
        </Link>
      </Card>
    </div>
  );
}
