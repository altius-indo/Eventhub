import type { Metadata } from "next";
import Link from "next/link";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, Field, Input } from "@/components/ui";
import { getDb } from "@/db";
import { resetLinkIsValid } from "@/lib/passwords";
import { getTranslator } from "@/lib/server/session";
import { resetPasswordAction } from "../../password/actions";

export const metadata: Metadata = { title: "New password", robots: { index: false }, referrer: "no-referrer" };

export default async function ResetPasswordPage({ params }: PageProps<"/login/reset/[token]">) {
  const { token } = await params;
  const { t } = await getTranslator();
  const valid = await resetLinkIsValid(getDb(), token);
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <Card>
        <h1 className="text-xl font-semibold">{t("password.newTitle")}</h1>
        {valid ? (
          <>
            <p className="mb-5 mt-1 text-sm text-muted">{t("password.rules")}</p>
            <SimpleForm action={resetPasswordAction.bind(null, token)}>
              <Field label={t("password.newPassword")} htmlFor="new-pw">
                <Input id="new-pw" name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" />
              </Field>
              <Field label={t("password.confirmPassword")} htmlFor="new-pw2">
                <Input id="new-pw2" name="confirm" type="password" required minLength={10} maxLength={128} autoComplete="new-password" />
              </Field>
              <SubmitButton className="w-full">{t("password.save")}</SubmitButton>
            </SimpleForm>
          </>
        ) : (
          <div className="mt-3 space-y-3">
            <Alert tone="danger">{t("password.linkInvalid")}</Alert>
            <Link href="/login/reset" className="inline-flex min-h-11 items-center text-sm text-primary underline">
              {t("password.resetTitle")}
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
