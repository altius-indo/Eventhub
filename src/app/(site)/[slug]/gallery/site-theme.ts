import type { CSSProperties } from "react";
import type { SiteContent, Website } from "@/db/schema";

/** The wedding site's look for the gallery pages (same palette as the site itself). */
const wraps: Record<SiteContent["theme"], string> = {
  ornate: "site-ornate text-[#3b0a14]",
  traditional: "bg-[#fbf6ee] text-[#2a1f1a]",
  modern: "bg-white text-[#141414]",
  minimal: "bg-[#fafafa] text-[#222]",
};
const cards: Record<SiteContent["theme"], string> = {
  ornate: "bg-white/90 border border-[#f0c46a] shadow-[0_8px_28px_-14px_rgba(155,17,30,0.45)]",
  traditional: "bg-white/80 border border-[#eadfcd]",
  modern: "bg-[#f6f6f6]",
  minimal: "bg-white border border-[#e6e6e6]",
};

export function siteLook(website: Website) {
  const c = website.published ?? website.draft;
  return { wrap: wraps[c.theme] ?? wraps.traditional, card: cards[c.theme] ?? cards.traditional, ornate: c.theme === "ornate", style: { "--accent": c.accent } as CSSProperties };
}

export const accentBtn = "inline-flex min-h-11 items-center justify-center rounded-full px-5 text-sm font-medium text-white disabled:opacity-60";
export const outlineBtn = "inline-flex min-h-11 items-center justify-center rounded-full border border-black/15 px-5 text-sm";
