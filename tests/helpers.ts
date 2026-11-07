import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { devOutbox } from "@/db/schema";
import type { Actor } from "@/lib/audit";
import { signInWithIdentifier } from "@/lib/auth-core";
import { parseIdentifier } from "@/lib/identifiers";

export const db = () => getDb();

export async function resetDb() {
  await db().execute(sql`
    TRUNCATE TABLE password_resets, approval_decisions, approval_requests, audit_logs, event_invitations,
      event_members, events, sessions, otp_challenges, user_identifiers, users, dev_outbox, rate_events,
      check_ins, seat_assignments, seating_tables, room_assignments, rooms, room_blocks, hotels,
      transfer_passengers, transfer_runs, run_sheet_items,
      document_blobs, documents, booking_key_dates, payments, invoice_lines, invoices, payment_milestones,
      fulfilments, bookings, budget_lines, quote_lines, quotes, quote_request_services, quote_requests,
      vendor_service_types, vendors, requirements, services, service_types,
      caterer_headcount_state, outbound_messages, thank_yous, thank_you_templates, gift_imports, cash_handovers, gifts, gift_item_recipients, gift_items,
      message_opt_outs, event_limit_overrides, platform_settings, message_usage, broadcasts, notification_prefs,
      notifications, thread_reads, messages, threads, vendor_contacts,
      storage_usage, storage_household_usage, storage_reservations, event_storage_overrides, storage_deletions, event_metrics,
      retention_notices, guest_erasure_requests,
      gallery_settings, gallery_albums, media_items, media_favourites, album_selections, album_selection_items,
      media_likes, media_comments, media_removal_requests, gallery_ready_notices
    RESTART IDENTITY CASCADE
  `);
}

export async function makeUser(identifier: string, name = identifier) {
  const id = parseIdentifier(identifier);
  if (!id) throw new Error(`bad identifier ${identifier}`);
  const { user } = await signInWithIdentifier(db(), id);
  const { users } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const [named] = await db().update(users).set({ name }).where(eq(users.id, user.id)).returning();
  return named;
}

export const actorOf = (user: { id: string; isAppAdmin: boolean }): Actor => ({ userId: user.id, isAppAdmin: false });

export async function outbox() {
  return db().select().from(devOutbox).orderBy(devOutbox.createdAt);
}

export function codeFrom(text: string): string {
  const m = text.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`no code in: ${text}`);
  return m[1];
}
