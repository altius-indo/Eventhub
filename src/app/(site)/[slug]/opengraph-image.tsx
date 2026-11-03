import { ImageResponse } from "next/og";
import { getDb } from "@/db";
import { formatDay } from "@/i18n/core";
import { getSiteBySlug } from "@/lib/website";

export const alt = "Wedding invitation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Link preview for WhatsApp and social media (WEB-09). Latin text only: the default font has no Devanagari. */
export default async function OgImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const row = await getSiteBySlug(getDb(), slug);
  const published = row?.website.published && row.website.visibility !== "passcode" ? row.website.published : null;
  const accent = published?.accent ?? "#8a1c2b";
  const names = (published && (published.sections.welcome.headline.en || row?.event.coupleNames)) || "You're invited";
  const event = row?.event;
  const dates = published && event?.startDate ? formatDay("en", event.startDate, { day: "numeric", month: "long", year: "numeric" }) : "";
  const city = published ? (event?.city ?? "") : "";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#fbf6ee", border: `24px solid ${accent}` }}>
        <div style={{ fontSize: 28, letterSpacing: 6, textTransform: "uppercase", color: "#6b5a4e" }}>Wedding invitation</div>
        <div style={{ fontSize: 84, fontWeight: 700, color: accent, marginTop: 24, textAlign: "center", maxWidth: 1000 }}>{names}</div>
        {(dates || city) && <div style={{ fontSize: 36, color: "#2a1f1a", marginTop: 24 }}>{[dates, city].filter(Boolean).join(" · ")}</div>}
      </div>
    ),
    size,
  );
}
