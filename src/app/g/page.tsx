import type { Metadata } from "next";
import en from "@/i18n/messages/en";
import hi from "@/i18n/messages/hi";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };

export default function InvalidGuestLink() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 text-center">
      <p lang="en">{en.portal.invalidLink}</p>
      <p lang="hi">{hi.portal.invalidLink}</p>
    </main>
  );
}
