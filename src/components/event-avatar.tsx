/** An event's logo, or its initials on the brand colours when it has none. Decorative (alt=""). */
export function EventAvatar({ name, logoUrl, size = "md" }: { name: string; logoUrl: string | null; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-8 text-xs" : "size-10 text-sm";
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt="" width={256} height={256} decoding="async" className={`${box} shrink-0 rounded-lg border border-border bg-surface object-cover`} />
    );
  }
  return (
    <span aria-hidden="true" className={`${box} inline-flex shrink-0 items-center justify-center rounded-lg bg-primary-soft font-semibold uppercase text-brand ring-1 ring-brand/30`}>
      {initials(name)}
    </span>
  );
}

/** Up to two initials from the event name ("Priya weds Arjun" → "PA"); works for Devanagari too. */
export function initials(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const skip = new Set(["weds", "and", "&", "ki", "ka", "ke"]);
  const picked = words.filter((w) => !skip.has(w.toLowerCase()));
  const use = picked.length ? picked : words;
  const first = use[0] ? Array.from(use[0])[0] : "";
  const last = use.length > 1 ? Array.from(use[use.length - 1])[0] : "";
  return (first + last).toUpperCase() || "•";
}
