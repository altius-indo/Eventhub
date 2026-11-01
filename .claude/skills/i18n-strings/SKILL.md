---
name: i18n-strings
description: Add or change user-facing text in EventHub in both English and Hindi. Use whenever a page, component, message, SMS/email template or audit entry needs new wording.
allowed-tools: Bash(npx vitest run tests/i18n.test.ts *) Read Edit
---

# Adding strings (English + Hindi)

1. Pick the namespace that matches the screen (`guests.*`, `rsvp.*`, `websiteEditor.*`, …) or add a
   new top-level section just above `offline:` in both files.
2. Add the key to `src/i18n/messages/en.ts`, then the same key in the same position in `hi.ts`.
   `hi.ts` is typed as `Messages`, so a missing key fails typecheck.
3. Placeholders: identical `{names}` in both languages. No string concatenation in code.
4. English: plain, short, friendly, sentence case. Avoid "1 rows"-style plurals ("Rows skipped: {n}").
5. Hindi: natural everyday Hindi in Devanagari, respectful (आप), the words families use (रस्म,
   मेहमान, परिवार, वधू पक्ष / वर पक्ष). Keep RSVP, WhatsApp, Excel, OTP and QR as-is. Not word-for-word.
6. SMS/WhatsApp texts: under ~300 characters, link last, no emojis that break on basic phones.
7. Audit log entries: `audit.actions["<action>"]`, phrased to follow the actor's name
   ("added the family {name}" / "ने परिवार {name} जोड़ा").
8. Run `npx vitest run tests/i18n.test.ts`. For larger batches, ask the `hindi-translator` agent to
   review the Hindi.
