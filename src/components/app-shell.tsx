import Link from "next/link";
import type { ReactNode } from "react";
import { getSessionContext, getTranslator } from "@/lib/server/session";
import { LanguageSwitcher } from "./language-switcher";
import { SignOutButton } from "./sign-out-button";

export async function AppShell({ children }: { children: ReactNode }) {
  const ctx = await getSessionContext();
  const { t, locale } = await getTranslator();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <Link href={ctx ? "/events" : "/login"} className="text-lg font-semibold tracking-tight text-brand">
            {t("app.name")}
          </Link>
          {ctx && (
            <nav aria-label="Main" className="flex items-center gap-1 text-sm">
              <Link href="/events" className="rounded-md px-2 py-1.5 hover:bg-surface-muted">
                {t("nav.events")}
              </Link>
              <Link href="/account" className="rounded-md px-2 py-1.5 hover:bg-surface-muted">
                {t("nav.account")}
              </Link>
              {ctx.user.isAppAdmin && (
                <Link href="/admin" className="rounded-md px-2 py-1.5 hover:bg-surface-muted">
                  {t("nav.admin")}
                </Link>
              )}
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher locale={locale} label={t("nav.language")} />
            {ctx && <SignOutButton label={t("common.signOut")} unsavedWarning={t("checkin.unsavedSignOut")} />}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
