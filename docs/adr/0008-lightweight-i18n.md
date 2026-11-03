# ADR-0008: Own lightweight i18n for English and Hindi

- **Status**: Accepted
- **Date**: 2026-11-01

## Context

v1 needs English and Hindi throughout, plus per-family language for guest pages and messages, with room for more languages (L10N-01/02). Locale is per user/family, not in the URL.

## Options considered

- next-intl (URL- or cookie-based).
- A typed catalogue and translator of our own.

## Decision

`src/i18n/messages/en.ts` is the source; `hi.ts` is typed as the same shape. `createTranslator(locale)` with `{placeholders}`, `translateDynamic` for runtime keys, Intl formatters for dates and INR. Locale comes from the user, the family, `?lang`, a cookie or the browser.

## Consequences

Missing translations fail typecheck; a test checks placeholders match. No plural rules: copy avoids plural-sensitive phrasing. Revisit (e.g. ICU messages) when adding languages with complex plurals.
