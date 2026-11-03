import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, Field, Input } from "@/components/ui";
import { getSessionContext, getTranslator, safeNext } from "@/lib/server/session";
import { passwordLoginAction } from "./actions";

export const metadata: Metadata = { title: "App Admin login", robots: { index: false } };

export default async function PasswordLoginPage({ searchParams }: PageProps<"/login/password">) {
  const { next, reset } = await searchParams;
  if (await getSessionContext()) redirect(safeNext(next));
  const { t } = await getTranslator();
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <Card>
        <h1 className="text-xl font-semibold">{t("password.title")}</h1>
        <p className="mb-5 mt-1 text-sm text-muted">{t("password.subtitle")}</p>
        {reset && (
          <div className="mb-4">
            <Alert tone="success">{t("password.resetDone")}</Alert>
          </div>
        )}
        <SimpleForm action={passwordLoginAction}>
          <input type="hidden" name="next" value={safeNext(next)} />
          <Field label={t("password.email")} htmlFor="pw-email">
            <Input id="pw-email" name="email" type="email" required autoComplete="username" />
          </Field>
          <Field label={t("password.password")} htmlFor="pw-password">
            <Input id="pw-password" name="password" type="password" required autoComplete="current-password" maxLength={128} />
          </Field>
          <SubmitButton className="w-full">{t("password.submit")}</SubmitButton>
        </SimpleForm>
        <div className="mt-4 flex flex-wrap justify-between gap-2 text-sm">
          <Link href="/login/reset" className="inline-flex min-h-11 items-center text-primary underline">
            {t("password.forgot")}
          </Link>
          <Link href={`/login${next ? `?next=${encodeURIComponent(safeNext(next))}` : ""}`} className="inline-flex min-h-11 items-center text-primary underline">
            {t("password.useCode")}
          </Link>
        </div>
      </Card>
    </div>
  );
}
