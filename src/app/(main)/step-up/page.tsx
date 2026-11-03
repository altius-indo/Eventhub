import { eq } from "drizzle-orm";
import { CodeForm } from "@/components/code-form";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Card, Field, Input } from "@/components/ui";
import { getDb } from "@/db";
import { userIdentifiers } from "@/db/schema";
import { formatIdentifier } from "@/lib/identifiers";
import { getTranslator, requireUser, safeNext } from "@/lib/server/session";
import { resendStepUpCodeAction, sendStepUpCodeAction, stepUpWithPasswordAction, verifyStepUpCodeAction } from "./actions";
import { stepUpFlowTarget } from "./flow";

export default async function StepUpPage({ searchParams }: PageProps<"/step-up">) {
  const { user } = await requireUser();
  const { next, sent } = await searchParams;
  const { t } = await getTranslator();
  const target = sent ? await stepUpFlowTarget(user.id) : null;
  const identifiers = await getDb().select().from(userIdentifiers).where(eq(userIdentifiers.userId, user.id));

  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <Card>
        <h1 className="text-xl font-semibold">{t("stepUp.title")}</h1>
        <p className="mb-5 mt-1 text-sm text-muted">
          {target ? t("auth.verify.sentTo", { to: target }) : t("stepUp.subtitle")}
        </p>
        {target ? (
          <CodeForm
            verify={verifyStepUpCodeAction}
            resend={resendStepUpCodeAction}
            labels={{ code: t("auth.verify.codeLabel"), submit: t("auth.verify.submit"), resend: t("auth.verify.resend") }}
          />
        ) : (
          <SimpleForm action={sendStepUpCodeAction}>
            <input type="hidden" name="next" value={safeNext(next)} />
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">{t("stepUp.sendTo")}</legend>
              {identifiers.map((id, i) => (
                <label key={id.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm">
                  <input type="radio" name="identifierId" value={id.id} defaultChecked={i === 0} />
                  {formatIdentifier(id)}
                </label>
              ))}
            </fieldset>
            <SubmitButton className="w-full">{t("stepUp.send")}</SubmitButton>
          </SimpleForm>
        )}
        {!target && user.isAppAdmin && user.passwordHash && (
          <SimpleForm action={stepUpWithPasswordAction} className="mt-5 space-y-3 border-t border-border pt-5">
            <input type="hidden" name="next" value={safeNext(next)} />
            <Field label={t("password.stepUpWithPassword")} htmlFor="stepup-pw">
              <Input id="stepup-pw" name="password" type="password" required autoComplete="current-password" maxLength={128} />
            </Field>
            <SubmitButton variant="secondary" className="w-full">
              {t("password.stepUpSubmit")}
            </SubmitButton>
          </SimpleForm>
        )}
      </Card>
    </div>
  );
}
