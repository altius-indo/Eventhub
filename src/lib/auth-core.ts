import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import type { Tx } from "@/db";
import { eventInvitations, eventMembers, sessions, userIdentifiers, users, type User } from "@/db/schema";
import { audit } from "./audit";
import { randomToken, sha256 } from "./crypto";
import type { Identifier } from "./identifiers";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

export type SessionRow = typeof sessions.$inferSelect;
export type RequestMeta = { ip?: string | null; userAgent?: string | null };

export class AccountSuspendedError extends Error {}

function adminIdentifiers(): Set<string> {
  return new Set(
    (process.env.APP_ADMIN_IDENTIFIERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function findUserByIdentifier(db: Tx, id: Identifier): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(userIdentifiers)
    .innerJoin(users, eq(users.id, userIdentifiers.userId))
    .where(and(eq(userIdentifiers.type, id.type), eq(userIdentifiers.value, id.value)))
    .limit(1);
  return row?.user ?? null;
}

/**
 * Finds or creates the user who owns a freshly verified identifier,
 * applies App Admin bootstrap and accepts any pending invitations.
 */
export async function signInWithIdentifier(
  db: Tx,
  id: Identifier,
  opts: { locale?: string } = {},
): Promise<{ user: User; isNew: boolean }> {
  let user = await findUserByIdentifier(db, id);
  let isNew = false;
  if (!user) {
    [user] = await db.insert(users).values({ locale: opts.locale ?? "en" }).returning();
    await db.insert(userIdentifiers).values({ userId: user.id, type: id.type, value: id.value });
    isNew = true;
  }
  if (user.suspendedAt) throw new AccountSuspendedError();
  if (!user.isAppAdmin && adminIdentifiers().has(id.value.toLowerCase())) {
    [user] = await db.update(users).set({ isAppAdmin: true, updatedAt: new Date() }).where(eq(users.id, user.id)).returning();
    await audit(db, { actor: null, action: "admin.bootstrap_granted", entityType: "user", entityId: user.id });
  }
  await acceptPendingInvitations(db, user.id);
  return { user, isNew };
}

/** Turns open invitations addressed to any of the user's identifiers into memberships. */
export async function acceptPendingInvitations(db: Tx, userId: string): Promise<number> {
  const ids = await db.select().from(userIdentifiers).where(eq(userIdentifiers.userId, userId));
  if (ids.length === 0) return 0;
  const invites = await db
    .select()
    .from(eventInvitations)
    .where(
      and(
        isNull(eventInvitations.acceptedAt),
        isNull(eventInvitations.revokedAt),
        or(...ids.map((i) => and(eq(eventInvitations.identifierType, i.type), eq(eventInvitations.identifierValue, i.value)))),
      ),
    );
  let accepted = 0;
  for (const invite of invites) {
    const [existing] = await db
      .select()
      .from(eventMembers)
      .where(and(eq(eventMembers.eventId, invite.eventId), eq(eventMembers.userId, userId)));
    if (!existing) {
      await db.insert(eventMembers).values({ eventId: invite.eventId, userId, role: invite.role });
    } else if (existing.role === "planner" && invite.role === "host") {
      await db.update(eventMembers).set({ role: "host" }).where(eq(eventMembers.id, existing.id));
    }
    await db
      .update(eventInvitations)
      .set({ acceptedAt: new Date(), acceptedBy: userId })
      .where(eq(eventInvitations.id, invite.id));
    await audit(db, {
      eventId: invite.eventId,
      actor: { userId, isAppAdmin: false },
      action: "member.joined",
      entityType: "member",
      entityId: userId,
      data: { role: invite.role },
    });
    accepted++;
  }
  return accepted;
}

export async function createSession(
  db: Tx,
  userId: string,
  meta: RequestMeta,
  now = new Date(),
): Promise<{ token: string; session: SessionRow }> {
  const token = randomToken();
  const [session] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: sha256(token),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      // Signing in just verified a fresh code, so it counts as a recent step-up.
      stepUpAt: now,
    })
    .returning();
  return { token, session };
}

/** Looks up a session token; extends the sliding expiry at most once per hour. */
export async function validateSessionToken(
  db: Tx,
  token: string,
  now = new Date(),
): Promise<{ session: SessionRow; user: User } | null> {
  if (!token) return null;
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row || row.user.suspendedAt) return null;
  if (now.getTime() - row.session.lastSeenAt.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    const [updated] = await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.session.id))
      .returning();
    return { session: updated, user: row.user };
  }
  return row;
}

export function hasRecentStepUp(session: Pick<SessionRow, "stepUpAt">, now = new Date()): boolean {
  return !!session.stepUpAt && now.getTime() - session.stepUpAt.getTime() < STEP_UP_WINDOW_MS;
}

export async function markStepUp(db: Tx, sessionId: string, now = new Date()) {
  await db.update(sessions).set({ stepUpAt: now }).where(eq(sessions.id, sessionId));
}

export async function revokeSession(db: Tx, userId: string, sessionId: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

export async function revokeAllSessions(db: Tx, userId: string, exceptSessionId?: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined,
      ),
    );
}

export async function listActiveSessions(db: Tx, userId: string, now = new Date()) {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .orderBy(sessions.lastSeenAt);
}

export async function listIdentifiers(db: Tx, userIds: string[]) {
  if (userIds.length === 0) return [];
  return db.select().from(userIdentifiers).where(inArray(userIdentifiers.userId, userIds));
}
