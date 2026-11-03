import Image from "next/image";
import { getTranslator } from "@/lib/server/session";

/**
 * Launch splash for the signed-in app (temporary branding). CSS-only: shown on a full page load,
 * fades out after a moment and never blocks taps. Not used on the public wedding websites.
 */
export async function SplashScreen() {
  const { t } = await getTranslator();
  return (
    <div className="eh-splash" aria-hidden="true">
      <Image src="/brand/annamahalakshmi.png" alt={t("app.splashLogo")} width={240} height={240} priority className="h-auto w-48 sm:w-60" />
      <p className="mt-4 text-lg font-semibold text-brand">{t("app.name")}</p>
    </div>
  );
}
