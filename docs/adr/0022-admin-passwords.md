# ADR-0022: Optional passwords for App Admins

- **Status**: Accepted
- **Date**: 2026-11-01
- **Requirements**: EVT-01 (exception), EVT-01d, EVT-10

## Context

EVT-01 says no passwords anywhere: everyone logs in with one-time codes (ADR-0003). The product owner asked for App Admins to also have a password, with a reset flow and a recovery email. Admins need a way in when email or SMS delivery is down or not yet set up, which happened on the first deployment, before the email domain was verified.

## Decision

- **Who:** only App Admins can use a password. Hosts, Planners, vendors and guests stay code-only. The login page links to a separate "App Admin login" page.
- **Storage:** passwords are kept only as scrypt hashes (N=32768, r=8, p=1, 16-byte salt), compared in constant time. The plain password is never stored, logged or committed.
- **Login:**
  - the error is the same whether the account exists, isn't an admin, or the password is wrong;
  - attempts are limited per IP and per email;
  - after 5 wrong tries the account locks for 15 minutes; logging in with a code still works.
- **First password:** `ADMIN_BOOTSTRAP_PASSWORD_HASH` (an scrypt hash, set in the hosting settings) is accepted once for an email listed in `APP_ADMIN_IDENTIFIERS` that has no password yet, then copied to the account. Admins then change it on the Account page.
- **Changing and removing:**
  - changing a password needs the current one; setting the first one, or removing it, needs a fresh code (step-up);
  - a change signs out the other devices.
- **Reset:**
  - a link valid for 30 minutes goes to the admin's login emails and verified recovery email;
  - it works once and only the SHA-256 of the token is stored;
  - using it signs out every session;
  - the request gets the same answer whether or not the account exists.
- **Recovery email:** verified with a one-time code before it's used.
- **Step-up:** an admin with a password can confirm sensitive actions (EVT-01d) with it instead of a code.
- **Audit:** password logins, changes, resets, lockouts and recovery-email changes are all logged.

## Consequences

The admin account is only as strong as its password; a second factor (TOTP) is a likely follow-up. `docs/REQUIREMENTS.md` EVT-01 notes this exception.
