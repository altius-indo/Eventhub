---
paths:
  - "src/**/*.{ts,tsx}"
---

# Security and privacy

- Authorisation always goes through `policy.ts` (`decide`/`can`). Planners' money/service changes must
  go through the approval engine, never write directly.
- Non-members get `notFound()`, not "forbidden", so event existence isn't revealed.
- Guests (cookie from `/g/<token>`) may only see their own household's data and functions they're
  invited to. Public website pages must never show the guest list, RSVPs, travel, rooms or gifts.
- Gift data: Hosts only, or Planners with explicit gift access (`gifts.view` / `gifts.record`).
- Never collect or store **guest** government IDs (Aadhaar, passport, PAN) — out of scope by decision (§8).
  Vendor PAN and bank details are business tax data: encrypted, masked, step-up to reveal (ADR-0019).
- Secrets: OTPs and passcodes are stored as HMACs; session tokens as SHA-256. Compare with
  `safeEqual`. Never log codes outside the dev outbox; never read or print `.env`.
- Public endpoints (find-my-invitation, passcode, OTP) are rate-limited (`allowAttempt`, otp limits)
  and give the same response whether or not something exists.
- Sensitive actions (removing a Host, deleting an event, admin actions) call `requireStepUp`.
- App Admin actions are audited with `actorIsAppAdmin` and visible to the event's Hosts.
- Only same-site relative redirects (`safeNext`). Escape LIKE patterns.
