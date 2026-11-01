import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Users & authentication
// ---------------------------------------------------------------------------

export const identifierType = pgEnum("identifier_type", ["email", "phone"]);
export const otpPurpose = pgEnum("otp_purpose", ["login", "step_up", "add_identifier"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  locale: text("locale").notNull().default("en"),
  isAppAdmin: boolean("is_app_admin").notNull().default(false),
  suspendedAt: ts("suspended_at"),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** A verified login identifier (email or E.164 phone) belonging to a user. */
export const userIdentifiers = pgTable(
  "user_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: identifierType("type").notNull(),
    value: text("value").notNull(),
    verifiedAt: ts("verified_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_identifiers_value_uq").on(t.type, t.value), index("user_identifiers_user_idx").on(t.userId)],
);

/** One-time code challenges. Codes are stored only as an HMAC. */
export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: otpPurpose("purpose").notNull(),
    identifierType: identifierType("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    channel: text("channel").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [
    index("otp_identifier_idx").on(t.identifierValue, t.createdAt),
    index("otp_ip_idx").on(t.ip, t.createdAt),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    stepUpAt: ts("step_up_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("sessions_token_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Events & membership
// ---------------------------------------------------------------------------

export const memberRole = pgEnum("member_role", ["host", "planner"]);
export const giftAccess = pgEnum("gift_access", ["none", "record", "full"]);

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  coupleNames: text("couple_names"),
  startDate: date("start_date"),
  endDate: date("end_date"),
  city: text("city"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  currency: text("currency").notNull().default("INR"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  /** Soft delete: set when a Host deletes the event; restorable until purgeAfter. */
  deletedAt: ts("deleted_at"),
  deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),
  purgeAfter: ts("purge_after"),
});

export const eventMembers = pgTable(
  "event_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    giftAccess: giftAccess("gift_access").notNull().default("none"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("event_members_uq").on(t.eventId, t.userId), index("event_members_user_idx").on(t.userId)],
);

/** Invitation by phone or email; accepted automatically when that identifier logs in. */
export const eventInvitations = pgTable(
  "event_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    identifierType: identifierType("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    role: memberRole("role").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    acceptedAt: ts("accepted_at"),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    index("event_invitations_identifier_idx").on(t.identifierType, t.identifierValue),
    uniqueIndex("event_invitations_open_uq")
      .on(t.eventId, t.identifierType, t.identifierValue)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Audit log & approvals
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorIsAppAdmin: boolean("actor_is_app_admin").notNull().default(false),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_event_idx").on(t.eventId, t.createdAt), index("audit_actor_idx").on(t.actorUserId, t.createdAt)],
);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "cancelled",
]);
export const approvalDecisionType = pgEnum("approval_decision_type", ["approve", "reject", "request_changes"]);

/** A Planner change waiting for a Host's decision (SVC-10, BGT-04). */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Monetary impact in paise, when the change has one. */
    amountPaise: bigint("amount_paise", { mode: "number" }),
    status: approvalStatus("status").notNull().default("pending"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    appliedAt: ts("applied_at"),
  },
  (t) => [index("approval_event_status_idx").on(t.eventId, t.status, t.createdAt)],
);

export const approvalDecisions = pgTable("approval_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => approvalRequests.id, { onDelete: "cascade" }),
  deciderId: uuid("decider_id").references(() => users.id, { onDelete: "set null" }),
  decision: approvalDecisionType("decision").notNull(),
  comment: text("comment"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Functions (sub-events) — ITN-01
// ---------------------------------------------------------------------------

export const functions = pgTable(
  "functions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    date: date("date"),
    startTime: time("start_time"),
    endTime: time("end_time"),
    venueName: text("venue_name"),
    venueAddress: text("venue_address"),
    mapUrl: text("map_url"),
    dressCode: text("dress_code"),
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("functions_event_idx").on(t.eventId, t.date, t.startTime)],
);

// ---------------------------------------------------------------------------
// Guests — GST-01..05
// ---------------------------------------------------------------------------

export const side = pgEnum("side", ["bride", "groom", "both"]);
export const ageGroup = pgEnum("age_group", ["adult", "child", "infant"]);
export const diet = pgEnum("diet", ["veg", "non_veg", "jain", "vegan", "other"]);

export const households = pgTable(
  "households",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    side: side("side").notNull().default("both"),
    address: text("address"),
    city: text("city"),
    postalCode: text("postal_code"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("households_event_idx").on(t.eventId, t.name)],
);

export const guests = pgTable(
  "guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isHead: boolean("is_head").notNull().default(false),
    relation: text("relation"),
    ageGroup: ageGroup("age_group").notNull().default("adult"),
    phone: text("phone"),
    email: text("email"),
    diet: diet("diet"),
    dietNotes: text("diet_notes"),
    accessibilityNotes: text("accessibility_notes"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("guests_household_idx").on(t.householdId, t.sortOrder),
    index("guests_event_idx").on(t.eventId),
    index("guests_phone_idx").on(t.eventId, t.phone),
    index("guests_email_idx").on(t.eventId, t.email),
    index("guests_tags_idx").using("gin", t.tags),
  ],
);

/** A guest invited to a function (GST-03). Household-level invites are stored per member. */
export const functionInvites = pgTable(
  "function_invites",
  {
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("function_invites_pk").on(t.functionId, t.guestId), index("function_invites_guest_idx").on(t.guestId)],
);

/** Saved guest-list filters (GST-05). */
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: jsonb("filters").$type<Record<string, string>>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("saved_views_event_idx").on(t.eventId)],
);

/** A parsed spreadsheet waiting for column mapping and confirmation (GST-04). */
export const guestImports = pgTable("guest_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  headers: jsonb("headers").$type<string[]>().notNull(),
  rows: jsonb("rows").$type<string[][]>().notNull(),
  mapping: jsonb("mapping").$type<Record<string, number>>(),
  completedAt: ts("completed_at"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Tasks — ITN-05
// ---------------------------------------------------------------------------

export const taskStatus = pgEnum("task_status", ["todo", "in_progress", "done"]);
export const taskPriority = pgEnum("task_priority", ["low", "normal", "high"]);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: date("due_date"),
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    functionId: uuid("function_id").references(() => functions.id, { onDelete: "set null" }),
    priority: taskPriority("priority").notNull().default("normal"),
    status: taskStatus("status").notNull().default("todo"),
    completedAt: ts("completed_at"),
    lastRemindedOn: date("last_reminded_on"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("tasks_event_idx").on(t.eventId, t.status, t.dueDate), index("tasks_assignee_idx").on(t.assigneeId, t.status)],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("task_comments_task_idx").on(t.taskId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Development outbox: messages "sent" by the dev delivery provider.
// ---------------------------------------------------------------------------

export const devOutbox = pgTable("dev_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  channel: text("channel").notNull(),
  to: text("to").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export type User = typeof users.$inferSelect;
export type Event = typeof events.$inferSelect;
export type EventMember = typeof eventMembers.$inferSelect;
export type MemberRole = (typeof memberRole.enumValues)[number];
export type GiftAccess = (typeof giftAccess.enumValues)[number];
export type IdentifierType = (typeof identifierType.enumValues)[number];
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type EventFunction = typeof functions.$inferSelect;
export type Household = typeof households.$inferSelect;
export type Guest = typeof guests.$inferSelect;
export type Side = (typeof side.enumValues)[number];
export type AgeGroup = (typeof ageGroup.enumValues)[number];
export type Diet = (typeof diet.enumValues)[number];
export type Task = typeof tasks.$inferSelect;
export type TaskStatus = (typeof taskStatus.enumValues)[number];
export type TaskPriority = (typeof taskPriority.enumValues)[number];
