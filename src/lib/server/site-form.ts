import "server-only";
import type { LocalizedText, SiteContent } from "@/db/schema";
import { SITE_ACCENTS, SITE_THEMES } from "../website";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const lt = (fd: FormData, k: string): LocalizedText => ({ en: str(fd, `${k}.en`).trim(), hi: str(fd, `${k}.hi`).trim() });
const on = (fd: FormData, k: string) => fd.get(k) === "on";

/** Reads the editor form into site content, keeping image lists and order from `current`. */
export function parseSiteForm(fd: FormData, current: SiteContent): SiteContent {
  const theme = str(fd, "theme");
  const accent = str(fd, "accent");
  const faqs: SiteContent["sections"]["faqs"]["items"] = [];
  for (let i = 0; i < 31; i++) {
    if (!fd.has(`faq.${i}.q.en`)) break;
    const item = { q: lt(fd, `faq.${i}.q`), a: lt(fd, `faq.${i}.a`) };
    if (item.q.en || item.q.hi || item.a.en || item.a.hi) faqs.push(item);
  }
  const people: SiteContent["sections"]["contact"]["people"] = [];
  for (let i = 0; i < 11; i++) {
    if (!fd.has(`contact.${i}.name`)) break;
    const p = { name: str(fd, `contact.${i}.name`).trim(), phone: str(fd, `contact.${i}.phone`).trim() };
    if (p.name || p.phone) people.push(p);
  }
  const s = current.sections;
  return {
    ...current,
    theme: (SITE_THEMES as readonly string[]).includes(theme) ? (theme as SiteContent["theme"]) : current.theme,
    accent: (SITE_ACCENTS as readonly string[]).includes(accent) ? accent : current.accent,
    monogram: str(fd, "monogram").trim().slice(0, 12),
    sections: {
      welcome: { visible: on(fd, "welcome.visible"), headline: lt(fd, "welcome.headline"), message: lt(fd, "welcome.message") },
      story: { visible: on(fd, "story.visible"), title: lt(fd, "story.title"), body: lt(fd, "story.body"), imageIds: s.story.imageIds },
      events: { visible: on(fd, "events.visible"), title: lt(fd, "events.title") },
      travel: { visible: on(fd, "travel.visible"), title: lt(fd, "travel.title"), body: lt(fd, "travel.body") },
      faqs: { visible: on(fd, "faqs.visible"), title: lt(fd, "faqs.title"), items: faqs.slice(0, 30) },
      gallery: { visible: on(fd, "gallery.visible"), title: lt(fd, "gallery.title"), imageIds: s.gallery.imageIds },
      gifts: { visible: on(fd, "gifts.visible"), title: lt(fd, "gifts.title"), body: lt(fd, "gifts.body") },
      contact: { visible: on(fd, "contact.visible"), title: lt(fd, "contact.title"), people: people.slice(0, 10) },
    },
  };
}
