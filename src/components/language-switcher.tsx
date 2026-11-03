"use client";

import { usePathname } from "next/navigation";
import { setLocaleAction } from "@/app/actions";
import type { Locale } from "@/i18n/core";

export function LanguageSwitcher({ locale, label }: { locale: Locale; label: string }) {
  const pathname = usePathname();
  return (
    <form action={setLocaleAction}>
      <input type="hidden" name="returnTo" value={pathname} />
      <label className="sr-only" htmlFor="locale-switch">
        {label}
      </label>
      <select
        id="locale-switch"
        name="locale"
        defaultValue={locale}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="min-h-9 rounded-md border border-border bg-surface px-2 text-sm"
      >
        <option value="en">English</option>
        <option value="hi">हिन्दी</option>
      </select>
    </form>
  );
}
