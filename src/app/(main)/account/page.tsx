import { eq } from "drizzle-orm";
import Link from "next/link";
import { CodeForm } from "@/components/code-form";
import { SimpleForm } from "@/components/simple-form";
import { SubmitButton } from "@/components/submit-button";
import { Badge, Card, CardTitle, Field, Input, PageHeader } from "@/components/ui";
import { getDb } from "@/db";
import { userIdentifiers } from "@/db/schema";
import { formatDateTime } from "@/i18n/core";
import { listActiveSessions } from "@/lib/auth-core";
import { formatIdentifier, maskIdentifier } from "@/lib/identifiers";
import { getTranslator, requireUser } from "@/lib/server/session";
import {
  removeIdentifierAction,
  resendAddIdentifierAction,
  revokeSessionAction,
  saveProfileAction,
  signOutOthersAction,
  startAddIdentifierAction,
  verifyAddIdentifierAction,
} from "./actions";
import { readAddIdFlow, readRecoveryFlow } from "./flow";
import { removePasswordAction, removeRecoveryEmailAction, sendRecoveryCodeAction, setPasswordAction, verifyRecoveryCodeAction } from "./password-actions";
import { ConfirmButton } from "@/components/confirm-button";
import { Alert } from "@/components/ui";

function describeDevice(ua: string | null): string {
  if (!ua) return "—";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" · ");
}

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const { user, session } = await requireUser();
  const { verify, recovery, recoverySaved } = await searchParams;
  const { t, locale } = await getTranslator();
  const db = getDb();
  const identifiers = await db.select().from(userIdentifiers).where(eq(userIdentifiers.userId, user.id));
  const sessions = await listActiveSessions(db, user.id);
  const flow = verify ? await readAddIdFlow() : null;
  const recoveryFlow = user.isAppAdmin && recovery ? await readRecoveryFlow() : null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("account.title")} />
      <div className="space-y-4">
        <Card>
          <CardTitle>{t("account.profile")}</CardTitle>
          <SimpleForm action={saveProfileAction}>
            <Field label={t("account.name")} htmlFor="name">
              <Input id="name" name="name" defaultValue={user.name ?? ""} required maxLength={80} autoComplete="name" />
            </Field>
            <SubmitButton>{t("common.save")}</SubmitButton>
          </SimpleForm>
        </Card>

        <Card>
          <CardTitle>{t("account.identifiers")}</CardTitle>
          <ul className="mb-4 divide-y divide-border">
            {identifiers.map((id) => (
              <li key={id.id} className="flex items-center justify-between gap-2 py-2">
                <span className="break-all">{formatIdentifier(id)}</span>
                {identifiers.length > 1 && (
                  <SimpleForm action={removeIdentifierAction} className="flex items-center gap-2">
                    <input type="hidden" name="identifierId" value={id.id} />
                    <SubmitButton variant="ghost" className="min-h-10">
                      {t("common.remove")}
                    </SubmitButton>
                  </SimpleForm>
                )}
              </li>
            ))}
          </ul>
          {flow ? (
            <div className="rounded-lg border border-border p-4">
              <p className="mb-3 text-sm">{t("account.verifyNew", { to: maskIdentifier(flow.id) })}</p>
              <CodeForm
                verify={verifyAddIdentifierAction}
                resend={resendAddIdentifierAction}
                labels={{ code: t("auth.verify.codeLabel"), submit: t("auth.verify.submit"), resend: t("auth.verify.resend") }}
              />
              <Link href="/account" className="mt-2 block text-center text-sm text-primary">
                {t("common.cancel")}
              </Link>
            </div>
          ) : (
            <SimpleForm action={startAddIdentifierAction} className="space-y-3">
              <Field label={t("account.addIdentifier")} htmlFor="identifier">
                <Input id="identifier" name="identifier" placeholder={t("auth.login.identifierPlaceholder")} required />
              </Field>
              <SubmitButton variant="secondary">{t("account.add")}</SubmitButton>
            </SimpleForm>
          )}
        </Card>

        {user.isAppAdmin && (
          <Card>
            <CardTitle>{t("password.accountTitle")}</CardTitle>
            <p className="mb-3 text-sm text-muted">{t("password.accountHelp")}</p>
            <p className="mb-3 text-sm">{user.passwordHash && user.passwordChangedAt ? t("password.hasPassword", { date: formatDateTime(locale, user.passwordChangedAt) }) : t("password.noPassword")}</p>
            <SimpleForm action={setPasswordAction} className="space-y-3">
              {user.passwordHash && (
                <Field label={t("password.current")} htmlFor="pw-current">
                  <Input id="pw-current" name="current" type="password" required autoComplete="current-password" maxLength={128} />
                </Field>
              )}
              <Field label={t("password.newPassword")} htmlFor="pw-new" hint={t("password.rules")}>
                <Input id="pw-new" name="password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" />
              </Field>
              <Field label={t("password.confirmPassword")} htmlFor="pw-confirm">
                <Input id="pw-confirm" name="confirm" type="password" required minLength={10} maxLength={128} autoComplete="new-password" />
              </Field>
              <SubmitButton>{t("password.save")}</SubmitButton>
            </SimpleForm>
            {user.passwordHash && (
              <SimpleForm action={removePasswordAction} className="mt-3 space-y-2">
                <ConfirmButton variant="ghost" className="text-danger" confirm={t("password.removeConfirm")}>
                  {t("password.remove")}
                </ConfirmButton>
              </SimpleForm>
            )}
          </Card>
        )}

        {user.isAppAdmin && (
          <Card>
            <CardTitle>{t("password.recoveryTitle")}</CardTitle>
            <p className="mb-3 text-sm text-muted">{t("password.recoveryHelp")}</p>
            {recoverySaved && (
              <div className="mb-3">
                <Alert tone="success">{t("password.recoverySaved")}</Alert>
              </div>
            )}
            <p className="mb-3 break-all text-sm">
              {user.recoveryEmail && user.recoveryEmailVerifiedAt ? t("password.recoveryCurrent", { email: user.recoveryEmail }) : t("password.recoveryNone")}
            </p>
            {recoveryFlow ? (
              <SimpleForm action={verifyRecoveryCodeAction} className="space-y-3">
                <p className="text-sm">{t("password.recoverySent", { email: recoveryFlow.email })}</p>
                <Field label={t("password.recoveryCode")} htmlFor="rec-code">
                  <Input id="rec-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
                </Field>
                <SubmitButton>{t("password.recoveryVerify")}</SubmitButton>
              </SimpleForm>
            ) : (
              <SimpleForm action={sendRecoveryCodeAction} className="space-y-3">
                <Field label={t("password.recoveryEmail")} htmlFor="rec-email">
                  <Input id="rec-email" name="email" type="email" required maxLength={200} />
                </Field>
                <SubmitButton variant="secondary">{t("password.recoverySend")}</SubmitButton>
              </SimpleForm>
            )}
            {user.recoveryEmail && !recoveryFlow && (
              <SimpleForm action={removeRecoveryEmailAction} className="mt-2">
                <SubmitButton variant="ghost">{t("password.recoveryRemove")}</SubmitButton>
              </SimpleForm>
            )}
          </Card>
        )}

        <Card>
          <CardTitle>{t("account.sessions")}</CardTitle>
          <ul className="mb-4 divide-y divide-border">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p className="flex items-center gap-2">
                    {describeDevice(s.userAgent)}
                    {s.id === session.id && <Badge tone="success">{t("account.thisDevice")}</Badge>}
                  </p>
                  <p className="text-sm text-muted">{t("account.lastActive", { time: formatDateTime(locale, s.lastSeenAt) })}</p>
                </div>
                {s.id !== session.id && (
                  <form action={revokeSessionAction}>
                    <input type="hidden" name="sessionId" value={s.id} />
                    <SubmitButton variant="ghost" className="min-h-10">
                      {t("account.signOutDevice")}
                    </SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
          {sessions.length > 1 && (
            <form action={signOutOthersAction}>
              <SubmitButton variant="secondary">{t("account.signOutOthers")}</SubmitButton>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
