# Architecture decision records

Why EventHub is built the way it is. Read the ADR for an area before changing it; record new
decisions with the `adr` skill (`.claude/skills/adr`) using [template.md](template.md).

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-drizzle-orm.md) | Drizzle ORM instead of Prisma | Accepted |
| [0003](0003-in-app-otp-auth.md) | Passwordless OTP auth built in-app | Accepted |
| [0004](0004-central-role-policy.md) | One policy function for all permissions | Accepted |
| [0005](0005-approval-engine.md) | Generic approval engine for Planner changes | Accepted |
| [0006](0006-signed-guest-links.md) | Signed guest links instead of stored tokens | Accepted |
| [0007](0007-dynamic-rendering.md) | Dynamic rendering; Cache Components off | Accepted |
| [0008](0008-lightweight-i18n.md) | Own lightweight i18n for English and Hindi | Accepted |
| [0009](0009-site-images-in-postgres.md) | Wedding-website images stored in Postgres (interim) | Accepted |
| [0010](0010-server-actions-forms.md) | Server actions with SimpleForm | Accepted |
| [0011](0011-routing-and-public-pages.md) | App areas protected by prefix; wedding sites at the root | Accepted |
| [0012](0012-message-delivery-providers.md) | Pluggable message delivery with a dev outbox | Accepted |
| [0013](0013-retention-and-deletion.md) | Event deletion: soft delete, undo window, cascade purge | Accepted |
| [0014](0014-checkin-pass-and-scanning.md) | Separate check-in pass, browser QR scanning, idempotent check-in | Accepted |
| [0015](0015-printable-html-instead-of-pdf.md) | Printable HTML pages instead of server-generated PDFs | Accepted |
| [0016](0016-proposals-as-rows.md) | Planner proposals as rows; edits as versioned diffs | Accepted |
| [0017](0017-auto-approve-thresholds.md) | Auto-approve thresholds inside the approval engine | Accepted |
| [0018](0018-documents-in-postgres.md) | Documents in Postgres behind a small module (interim) | Accepted |
| [0019](0019-vendor-field-encryption.md) | Field encryption for vendor bank details and PAN | Accepted |
| [0020](0020-money-arithmetic.md) | Money arithmetic and derived payment statuses | Accepted |
| [0021](0021-hosting-on-vercel.md) | Hosting on Vercel with Neon Postgres | Accepted |
| [0022](0022-admin-passwords.md) | Optional passwords for App Admins | Accepted |
| [0023](0023-vendor-portal-logins.md) | Vendor portal logins via vendor contacts | Accepted |
| [0024](0024-outbox-for-outgoing-messages.md) | Outbox table for outgoing messages | Accepted |
| [0025](0025-messaging-quotas.md) | Per-event messaging quotas reserved at enqueue | Accepted |
| [0026](0026-chat-by-polling.md) | In-app chat by short polling | Accepted |
| [0027](0027-offline-envelope-queue.md) | Offline envelope entry with client keys | Accepted |
| [0028](0028-caterer-headcount-baseline-and-lock.md) | Caterer headcount: per-booking baseline, lazy freeze at the lock | Accepted |
| [0029](0029-notifications-rendered-at-read.md) | Notifications stored as kind + data, rendered when read | Accepted |
| [0030](0030-object-storage.md) | Object storage: private Vercel Blob in production, filesystem in development | Accepted |
| [0031](0031-direct-uploads-and-quotas.md) | Gallery uploads go straight to storage, with quota reserved first | Accepted |
| [0032](0032-renditions.md) | Gallery renditions made by an in-app worker with sharp | Accepted |
| [0033](0033-retention-and-deletion.md) | Retention, archive and deletion of event data | Accepted |
| [0034](0034-offline-check-in-snapshot.md) | Offline check-in snapshot and day-of page caching | Accepted |
| [0035](0035-preview-database.md) | Preview deployments use their own database | Accepted |
