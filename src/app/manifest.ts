import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "EventHub",
    short_name: "EventHub",
    description: "Plan big weddings together: guests, itinerary, vendors, budgets and messaging in one place.",
    start_url: "/events",
    scope: "/",
    display: "standalone",
    background_color: "#f7f7f5",
    theme_color: "#3d4f7c",
    lang: "en",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
