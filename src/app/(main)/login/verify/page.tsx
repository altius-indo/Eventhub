import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CodeForm } from "@/components/code-form";
import { Card } from "@/components/ui";
import { maskIdentifier } from "@/lib/identifiers";
import { getTranslator } from "@/lib/server/session";
import { resendLoginCodeAction, verifyLoginCodeAction } from "../actions";
import { readLoginFlow } from "../flow";

export const metadata: Metadata = { title: "Enter code" };

export default async function VerifyPage() {
  const flow = await readLoginFlow();
  if (!flow) redirect("/login");
  const { t } = await getTranslator();
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <Card>
        <h1 className="text-xl font-semibold">{t("auth.verify.title")}</h1>
        <p className="mb-5 mt-1 text-sm text-muted">{t("auth.verify.sentTo", { to: maskIdentifier(flow.id) })}</p>
        <CodeForm
          verify={verifyLoginCodeAction}
          resend={resendLoginCodeAction}
          labels={{ code: t("auth.verify.codeLabel"), submit: t("auth.verify.submit"), resend: t("auth.verify.resend") }}
        />
        <p className="mt-4 text-center text-sm">
          <Link href="/login" className="text-primary underline-offset-2 hover:underline">
            {t("auth.verify.changeIdentifier")}
          </Link>
        </p>
      </Card>
    </div>
  );
}
