# ADR-0019: Field encryption for vendor bank details and PAN

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: VND-01, EVT-01d, §4 Security

## Context

§4 requires vendor bank and tax data to be encrypted at rest and masked in the UI. VND-01 asks for PAN, which is a vendor's business tax identifier. §8's ban on government ID collection applies to *guests*.

## Decision

- **Encryption**: PAN and bank details (account name, number, IFSC, UPI) are encrypted with AES-256-GCM using a random IV per value, stored as `v1.<iv>.<tag>.<ciphertext>`. Only the last 4 characters are stored in clear, for masked display.
- **Key**: `DATA_ENCRYPTION_KEY` (32 bytes, base64url) when set. Otherwise the key is derived from `AUTH_SECRET` with HKDF, so development works without extra setup. Production should set its own key and keep a backup of it.
- **Showing full values**: they appear only on a dedicated page, after a fresh one-time code (step-up). Every view is audited as `vendor.bank_viewed`. Values never go into audit data or approval payloads.
- **Project rule**: the security rule now says *guest* government IDs; vendor PAN is allowed as business tax data under the controls above.

## Consequences

Losing the key loses bank details; rotation means re-encrypting with a new version prefix. Searching by PAN or account number isn't possible (not needed).
