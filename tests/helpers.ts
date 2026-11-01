import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { devOutbox } from "@/db/schema";
import type { Actor } from "@/lib/audit";
import { signInWithIdentifier } from "@/lib/auth-core";
import { parseIdentifier } from "@/lib/identifiers";

export const db = () => getDb();

export async function resetDb() {
  await db().execute(sql`
    TRUNCATE TABLE approval_decisions, approval_requests, audit_logs, event_invitations,
      event_members, events, sessions, otp_challenges, user_identifiers, users, dev_outbox, rate_events,
      check_ins, seat_assignments, seating_tables, room_assignments, rooms, room_blocks, hotels,
      transfer_passengers, transfer_runs, run_sheet_items
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
