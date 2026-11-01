import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { phoneLoginEnabled } from "@/lib/delivery";
import { getSessionContext, getTranslator, safeNext } from "@/lib/server/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  if (await getSessionContext()) redirect(safeNext(next));
  const { t } = await getTranslator();
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <p className="mb-6 text-center text-sm text-muted">{t("app.tagline")}</p>
      <Card>
        <h1 className="text-xl font-semibold">{t("auth.login.title")}</h1>
        <p className="mb-5 mt-1 text-sm text-muted">{t("auth.login.subtitle")}</p>
        <LoginForm
          next={safeNext(next)}
          phoneEnabled={phoneLoginEnabled()}
          labels={{
            identifier: t("auth.login.identifierLabel"),
            placeholder: t("auth.login.identifierPlaceholder"),
            channel: t("auth.login.channelLabel"),
            sms: t("auth.login.channelSms"),
            whatsapp: t("auth.login.channelWhatsapp"),
            submit: t("auth.login.sendCode"),
          }}
        />
      </Card>
    </div>
  );
}
