---
paths:
  - "src/components/**/*.tsx"
  - "src/app/**/*.tsx"
  - "src/app/globals.css"
---

# UI

- Use tokens from `globals.css` via Tailwind (`bg-surface`, `text-muted`, `border-border`, `bg-primary`,
  `text-danger`, …) and components from `src/components/ui.tsx`. No raw hex colours in the app UI
  (the wedding website themes in `(site)` are the exception).
- Must work in light and dark mode, at 360px wide (no horizontal page scroll), with 44px tap targets
  (`min-h-11`). Wide tables scroll inside their card (`overflow-x-auto`).
- Forms: `Field` + `Input/Select/Textarea`, labels always visible, errors via `Alert`. Destructive
  actions use `ConfirmButton`.
- Mostly server components; add `"use client"` only for interactivity, and pass translated strings in.
- Accessibility: real buttons/links, `aria-label` on icon-only buttons, `aria-current` for nav,
  `sr-only` labels for compact selects, focus rings preserved.
