import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "EventHub",
    short_name: "EventHub",
    description: "Plan big weddings together: guests, itinerary, vendors, budgets and messaging in one place.",
    start_url: "/events",
    scope: "/",
    display: "standalone",
    background_color: "#fff7f5",
    theme_color: "#792943",
    lang: "en",
    icons: [
      { src: "/icons/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
