import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegister } from "@/components/sw-register";
import { getLocale } from "@/lib/server/session";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? "http://localhost:3000"),
  title: { default: "EventHub", template: "%s · EventHub" },
  description: "Plan big weddings together: guests, itinerary, vendors, budgets and messaging in one place.",
  applicationName: "EventHub",
  appleWebApp: {
    capable: true,
    title: "EventHub",
    statusBarStyle: "default",
    // iOS doesn't build a launch screen from the manifest; it needs an image per screen size.
    startupImage: [
      { url: "/icons/launch-750x1334.png?v=2", media: "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" },
      { url: "/icons/launch-1170x2532.png?v=2", media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" },
      { url: "/icons/launch-1179x2556.png?v=2", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" },
      { url: "/icons/launch-1290x2796.png?v=2", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" },
    ],
  },
  // ?v=2: the logo replaced the old "EH" icon; new URLs make browsers and installed apps refetch.
  icons: { icon: "/icons/icon-192.png?v=2", apple: "/icons/apple-touch-icon.png?v=2" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fff7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1316" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
