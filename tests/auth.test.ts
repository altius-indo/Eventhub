import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { eventMembers, users } from "@/db/schema";
import {
  AccountSuspendedError,
  createSession,
  hasRecentStepUp,
  markStepUp,
  revokeAllSessions,
  revokeSession,
  SESSION_TTL_MS,
  signInWithIdentifier,
  validateSessionToken,
} from "@/lib/auth-core";
import { createEvent, inviteMember } from "@/lib/events";
import { actorOf, db, makeUser, resetDb } from "./helpers";

beforeEach(resetDb);

const meta = { ip: "1.2.3.4", userAgent: "test" };

describe("sign in", () => {
  it("creates a user on first login and reuses it afterwards", async () => {
    const id = { type: "email" as const, value: "new@example.com" };
    const first = await signInWithIdentifier(db(), id);
    const second = await signInWithIdentifier(db(), id);
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it("makes configured identifiers App Admins", async () => {
    const { user } = await signInWithIdentifier(db(), { type: "email", value: "admin@example.com" });
    expect(user.isAppAdmin).toBe(true);
  });

  it("refuses suspended users", async () => {
    const u = await makeUser("s@example.com");
    await db().update(users).set({ suspendedAt: new Date() }).where(eq(users.id, u.id));
    await expect(signInWithIdentifier(db(), { type: "email", value: "s@example.com" })).rejects.toBeInstanceOf(AccountSuspendedError);
  });

  it("accepts pending invitations on first login", async () => {
    const host = await makeUser("host@example.com", "Asha");
    const event = await createEvent(db(), actorOf(host), { name: "Wedding" });
    await inviteMember(db(), {
      event,
      actor: actorOf(host),
      inviterName: "Asha",
      identifier: { type: "phone", value: "+919876543210" },
      role: "planner",
      locale: "en",
      appUrl: "http://localhost:3000",
    });
    const { user } = await signInWithIdentifier(db(), { type: "phone", value: "+919876543210" });
    const [m] = await db().select().from(eventMembers).where(eq(eventMembers.userId, user.id));
    expect(m).toMatchObject({ eventId: event.id, role: "planner" });
  });
});

describe("sessions", () => {
  it("validates, slides and expires", async () => {
    const u = await makeUser("a@example.com");
    const start = new Date("2026-01-01T00:00:00Z");
    const { token } = await createSession(db(), u.id, meta, start);
    expect(await validateSessionToken(db(), token, new Date(start.getTime() + 1000))).not.toBeNull();

    // Using it after 20 days pushes expiry out to 30 days from then
    const day20 = new Date(start.getTime() + 20 * 24 * 3600_000);
    const touched = await validateSessionToken(db(), token, day20);
    expect(touched?.session.expiresAt.getTime()).toBe(day20.getTime() + SESSION_TTL_MS);

    expect(await validateSessionToken(db(), token, new Date(day20.getTime() + SESSION_TTL_MS + 1))).toBeNull();
    expect(await validateSessionToken(db(), "not-a-token")).toBeNull();
  });

  it("can be revoked individually or everywhere else", async () => {
    const u = await makeUser("a@example.com");
    const a = await createSession(db(), u.id, meta);
    const b = await createSession(db(), u.id, meta);
    const c = await createSession(db(), u.id, meta);
    await revokeSession(db(), u.id, a.session.id);
    expect(await validateSessionToken(db(), a.token)).toBeNull();
    await revokeAllSessions(db(), u.id, b.session.id);
    expect(await validateSessionToken(db(), b.token)).not.toBeNull();
    expect(await validateSessionToken(db(), c.token)).toBeNull();
  });

  it("ends sessions of suspended users", async () => {
    const u = await makeUser("a@example.com");
    const { token } = await createSession(db(), u.id, meta);
    await db().update(users).set({ suspendedAt: new Date() }).where(eq(users.id, u.id));
    expect(await validateSessionToken(db(), token)).toBeNull();
  });

  it("tracks step-up for 10 minutes", async () => {
    const u = await makeUser("a@example.com");
    const created = new Date("2026-01-01T00:00:00Z");
    const { session } = await createSession(db(), u.id, meta, created);
    // A fresh login counts as a step-up, but only for 10 minutes
    expect(hasRecentStepUp(session, new Date(created.getTime() + 60_000))).toBe(true);
    expect(hasRecentStepUp(session, new Date(created.getTime() + 11 * 60_000))).toBe(false);
    const now = new Date();
    await markStepUp(db(), session.id, now);
    expect(hasRecentStepUp({ stepUpAt: now }, new Date(now.getTime() + 9 * 60_000))).toBe(true);
    expect(hasRecentStepUp({ stepUpAt: now }, new Date(now.getTime() + 11 * 60_000))).toBe(false);
  });
});
