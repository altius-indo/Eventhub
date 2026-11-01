import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Users & authentication
// ---------------------------------------------------------------------------

export const identifierType = pgEnum("identifier_type", ["email", "phone"]);
export const otpPurpose = pgEnum("otp_purpose", ["login", "step_up", "add_identifier", "recovery_email"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  locale: text("locale").notNull().default("en"),
  isAppAdmin: boolean("is_app_admin").notNull().default(false),
  suspendedAt: ts("suspended_at"),
  /** App Admins only (ADR-0022): scrypt hash, never the password. Everyone else signs in with codes. */
  passwordHash: text("password_hash"),
  passwordChangedAt: ts("password_changed_at"),
  failedPasswordAttempts: integer("failed_password_attempts").notNull().default(0),
  passwordLockedUntil: ts("password_locked_until"),
  /** Where password-reset links also go; verified with a code before use. */
  recoveryEmail: text("recovery_email"),
  recoveryEmailVerifiedAt: ts("recovery_email_verified_at"),
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

/** One-time password reset links (ADR-0022). Only the SHA-256 of the token is stored. */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("password_resets_token_uq").on(t.tokenHash), index("password_resets_user_idx").on(t.userId, t.createdAt)],
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
  /** Guests can change RSVPs until the end of this day (event timezone). */
  rsvpDeadline: date("rsvp_deadline"),
  /** Guest pages show logistics only once the team switches these on (ITN-04). */
  shareTransfers: boolean("share_transfers").notNull().default(false),
  shareRooms: boolean("share_rooms").notNull().default(false),
  shareSeating: boolean("share_seating").notNull().default(false),
  currency: text("currency").notNull().default("INR"),
  /** GST place of supply (2-digit state code) used to suggest CGST+SGST vs IGST. */
  placeOfSupply: text("place_of_supply"),
  /** Who gets payment reminders (PAY-05): "hosts" or "hosts_planners". */
  paymentRemindersTo: text("payment_reminders_to").notNull().default("hosts_planners"),
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
    /** What the request is about, for "pending change" badges and filters (SVC-10). */
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    functionIds: uuid("function_ids").array().notNull().default(sql`'{}'::uuid[]`),
    lastRemindedAt: ts("last_reminded_at"),
  },
  (t) => [
    index("approval_event_status_idx").on(t.eventId, t.status, t.createdAt),
    index("approval_entity_idx").on(t.entityType, t.entityId),
  ],
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
    /** Listed on the public wedding website (WEB-04); private functions show only to invited guests. */
    isPublic: boolean("is_public").notNull().default(false),
    /** Whether the exact venue address/map is shown publicly or only to invited guests. */
    venuePublic: boolean("venue_public").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("functions_event_idx").on(t.eventId, t.date, t.startTime), unique("functions_event_uq").on(t.id, t.eventId)],
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
    /** Language for this family's guest pages and messages (L10N-02). */
    locale: text("locale").notNull().default("en"),
    /** Extra people (+1s, children) the family may add when they RSVP. */
    plusOnesAllowed: integer("plus_ones_allowed").notNull().default(0),
    /** Guest links are signed with this version; bumping it invalidates old links (GST-06). */
    linkVersion: integer("link_version").notNull().default(1),
    linkRevokedAt: ts("link_revoked_at"),
    linkSentAt: ts("link_sent_at"),
    rsvpRemindedAt: ts("rsvp_reminded_at"),
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
    /** Added by the family themselves as a +1 when RSVPing. */
    addedByGuest: boolean("added_by_guest").notNull().default(false),
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
// RSVP & travel — RSV-01..05, TRV-01/02
// ---------------------------------------------------------------------------

export const rsvpStatus = pgEnum("rsvp_status", ["attending", "maybe", "declined"]);

export const rsvps = pgTable(
  "rsvps",
  {
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    status: rsvpStatus("status").notNull(),
    /** Null when the guest answered themselves; otherwise the team member who recorded it. */
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    respondedAt: ts("responded_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("rsvps_pk").on(t.functionId, t.guestId), index("rsvps_guest_idx").on(t.guestId)],
);

export const travelMode = pgEnum("travel_mode", ["flight", "train", "bus", "car", "other"]);

export const guestTravel = pgTable("guest_travel", {
  guestId: uuid("guest_id")
    .primaryKey()
    .references(() => guests.id, { onDelete: "cascade" }),
  arrivalMode: travelMode("arrival_mode"),
  arrivalNumber: text("arrival_number"),
  arrivalAt: timestamp("arrival_at", { withTimezone: false }),
  arrivalPoint: text("arrival_point"),
  needsPickup: boolean("needs_pickup").notNull().default(false),
  departureMode: travelMode("departure_mode"),
  departureNumber: text("departure_number"),
  departureAt: timestamp("departure_at", { withTimezone: false }),
  departurePoint: text("departure_point"),
  needsDrop: boolean("needs_drop").notNull().default(false),
  notes: text("notes"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedByGuest: boolean("updated_by_guest").notNull().default(false),
});

// ---------------------------------------------------------------------------
// Wedding website — WEB-01..09
// ---------------------------------------------------------------------------

export const siteVisibility = pgEnum("site_visibility", ["unlisted", "passcode", "public"]);

export type LocalizedText = { en?: string; hi?: string };
export type SiteContent = {
  theme: "traditional" | "modern" | "minimal";
  accent: string;
  monogram: string;
  coverImageId: string | null;
  sections: {
    welcome: { visible: boolean; headline: LocalizedText; message: LocalizedText };
    story: { visible: boolean; title: LocalizedText; body: LocalizedText; imageIds: string[] };
    events: { visible: boolean; title: LocalizedText };
    travel: { visible: boolean; title: LocalizedText; body: LocalizedText };
    faqs: { visible: boolean; title: LocalizedText; items: { q: LocalizedText; a: LocalizedText }[] };
    gallery: { visible: boolean; title: LocalizedText; imageIds: string[] };
    gifts: { visible: boolean; title: LocalizedText; body: LocalizedText };
    contact: { visible: boolean; title: LocalizedText; people: { name: string; phone: string }[] };
  };
  order: (keyof SiteContent["sections"])[];
};

export const websites = pgTable(
  "websites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    visibility: siteVisibility("visibility").notNull().default("unlisted"),
    passcodeHash: text("passcode_hash"),
    passcodeVersion: integer("passcode_version").notNull().default(1),
    draft: jsonb("draft").$type<SiteContent>().notNull(),
    published: jsonb("published").$type<SiteContent>(),
    publishedAt: ts("published_at"),
    publishedBy: uuid("published_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("websites_event_uq").on(t.eventId), uniqueIndex("websites_slug_uq").on(t.slug)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** Images for the wedding website (cover, story, gallery), stored resized as WebP. */
export const siteImages = pgTable(
  "site_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("site_images_event_idx").on(t.eventId)],
);

/** Generic attempt log for rate limiting public endpoints (find-my-invitation, passcode). */
export const rateEvents = pgTable(
  "rate_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("rate_events_idx").on(t.kind, t.key, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Logistics — TRV-03..06 (transfers), TRV-04/05 (hotels & rooms)
// Wall-clock times: `timestamp without time zone` holding event-local time (see travel.ts).
// ---------------------------------------------------------------------------

const wallClock = (name: string) => timestamp(name, { withTimezone: false });

export const transferKind = pgEnum("transfer_kind", ["pickup", "drop", "shuttle"]);

export const transferRuns = pgTable(
  "transfer_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: transferKind("kind").notNull(),
    /** Shuttles (and venue drops) belong to a function; kept if the function is deleted. */
    functionId: uuid("function_id").references(() => functions.id, { onDelete: "set null" }),
    departsAt: wallClock("departs_at").notNull(),
    fromPlace: text("from_place").notNull(),
    toPlace: text("to_place").notNull(),
    vehicle: text("vehicle"),
    driverName: text("driver_name"),
    driverPhone: text("driver_phone"),
    capacity: integer("capacity").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("transfer_runs_event_idx").on(t.eventId, t.departsAt)],
);

export const transferPassengers = pgTable(
  "transfer_passengers",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => transferRuns.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("transfer_passengers_pk").on(t.runId, t.guestId), index("transfer_passengers_guest_idx").on(t.guestId)],
);

export const hotels = pgTable(
  "hotels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    phone: text("phone"),
    mapUrl: text("map_url"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("hotels_event_idx").on(t.eventId)],
);

export const roomBlocks = pgTable(
  "room_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    hotelId: uuid("hotel_id")
      .notNull()
      .references(() => hotels.id, { onDelete: "cascade" }),
    roomType: text("room_type").notNull(),
    maxOccupancy: integer("max_occupancy").notNull().default(2),
    blockedCount: integer("blocked_count").notNull(),
    /** Informational rate per night; the binding cost becomes a booking in M5. Never shown to guests. */
    ratePaise: bigint("rate_paise", { mode: "number" }),
    checkIn: date("check_in").notNull(),
    checkOut: date("check_out").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("room_blocks_hotel_idx").on(t.hotelId)],
);

/** Room slots materialised from a block's blockedCount; `label` is the hotel's room number once known. */
export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    blockId: uuid("block_id")
      .notNull()
      .references(() => roomBlocks.id, { onDelete: "cascade" }),
    label: text("label"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("rooms_block_idx").on(t.blockId, t.sortOrder)],
);

/** Stays are half-open [checkIn, checkOut): leaving and arriving the same day doesn't overlap. */
export const roomAssignments = pgTable(
  "room_assignments",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    checkIn: date("check_in").notNull(),
    checkOut: date("check_out").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("room_assignments_pk").on(t.roomId, t.guestId), index("room_assignments_guest_idx").on(t.guestId)],
);

// ---------------------------------------------------------------------------
// Seating & check-in — SEAT-01..03
// ---------------------------------------------------------------------------

export const seatingTables = pgTable(
  "seating_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    capacity: integer("capacity").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  // A real unique constraint (not just an index) so seat_assignments can reference (id, function_id).
  (t) => [unique("seating_tables_fn_uq").on(t.id, t.functionId), index("seating_tables_fn_idx").on(t.functionId, t.sortOrder)],
);

export const seatAssignments = pgTable(
  "seat_assignments",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    functionId: uuid("function_id").notNull(),
    tableId: uuid("table_id").notNull(),
    guestId: uuid("guest_id").notNull(),
  },
  (t) => [
    uniqueIndex("seat_assignments_pk").on(t.functionId, t.guestId),
    index("seat_assignments_table_idx").on(t.tableId),
    // The table must belong to the same function.
    foreignKey({ columns: [t.tableId, t.functionId], foreignColumns: [seatingTables.id, seatingTables.functionId], name: "seat_table_fk" }).onDelete("cascade"),
    // Only invited guests can be seated; un-inviting removes the seat.
    foreignKey({ columns: [t.functionId, t.guestId], foreignColumns: [functionInvites.functionId, functionInvites.guestId], name: "seat_invite_fk" }).onDelete("cascade"),
  ],
);

export const checkinSource = pgEnum("checkin_source", ["scan", "manual", "walk_in"]);

/** One row per guest per function; inserts use ON CONFLICT DO NOTHING so retries never double count. */
export const checkIns = pgTable(
  "check_ins",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    /** A real instant (timestamptz), unlike the wall-clock logistics times. */
    checkedInAt: ts("checked_in_at").notNull(),
    recordedAt: ts("recorded_at").notNull().defaultNow(),
    checkedInBy: uuid("checked_in_by").references(() => users.id, { onDelete: "set null" }),
    source: checkinSource("source").notNull(),
    /** Checked in although not invited to this function (allowed with a warning). */
    uninvited: boolean("uninvited").notNull().default(false),
  },
  (t) => [uniqueIndex("check_ins_pk").on(t.functionId, t.guestId), index("check_ins_event_idx").on(t.eventId, t.functionId)],
);

// ---------------------------------------------------------------------------
// Run sheet — ITN-03
// ---------------------------------------------------------------------------

export const runItemStatus = pgEnum("run_item_status", ["pending", "in_progress", "done"]);

export const runSheetItems = pgTable(
  "run_sheet_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    startsAt: wallClock("starts_at").notNull(),
    durationMin: integer("duration_min"),
    title: text("title").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** External contact (vendor, pandit, DJ…) until vendors exist in M5. */
    ownerName: text("owner_name"),
    ownerPhone: text("owner_phone"),
    location: text("location"),
    notes: text("notes"),
    /** Fixed-time items (e.g. muhurat) don't move when later items are shifted. */
    timeLocked: boolean("time_locked").notNull().default(false),
    status: runItemStatus("status").notNull().default("pending"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("run_sheet_items_fn_idx").on(t.functionId, t.startsAt, t.sortOrder)],
);

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
// Services, vendors & money — SVC, VND, BGT, PAY (milestone 5)
// Money is integer paise. Planner-created rows start as approval_state "proposed" (ADR-0016).
// FKs from money rows to functions/vendors use "no action": deleting a function or vendor
// that has services/bookings fails, while deleting the whole event still cascades.
// ---------------------------------------------------------------------------

export const approvalState = pgEnum("approval_state", ["proposed", "approved", "rejected"]);
export const catalogueKind = pgEnum("catalogue_kind", ["service", "standalone"]);
export const requirementLifecycle = pgEnum("requirement_lifecycle", ["open", "delivered", "cancelled"]);
export const requirementPriority = pgEnum("requirement_priority", ["must", "nice"]);
export const quoteLineScope = pgEnum("quote_line_scope", ["requirement", "service", "package"]);
export const bookingStatus = pgEnum("booking_status", ["pending_approval", "confirmed", "cancelled"]);
export const taxType = pgEnum("tax_type", ["none", "cgst_sgst", "igst"]);
export const paymentMode = pgEnum("payment_mode", ["upi", "bank", "cheque", "cash", "card"]);
export const paymentState = pgEnum("payment_state", ["recorded", "confirmed", "rejected"]);
export const milestoneKind = pgEnum("milestone_kind", ["advance", "milestone", "final"]);
export const documentKind = pgEnum("document_kind", ["contract", "quote", "invoice", "receipt", "brief", "other"]);

/** Who pays (BGT-03): a reporting label only. Shared splits are by percent (basis points) or fixed paise to the bride's side. */
export type Payer =
  | { kind: "bride" }
  | { kind: "groom" }
  | { kind: "shared"; mode: "percent"; brideBps: number }
  | { kind: "shared"; mode: "fixed"; bridePaise: number };

export type RequirementTemplate = { title: string; unit?: string; quantity?: number; specs?: string };

/** Service catalogue and budget categories (SVC-01, BGT-04 thresholds). */
export const serviceTypes = pgTable(
  "service_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Built-in types have a key (translated name); custom ones only a name. */
    systemKey: text("system_key"),
    name: text("name").notNull(),
    kind: catalogueKind("kind").notNull().default("service"),
    requirementTemplates: jsonb("requirement_templates").$type<RequirementTemplate[]>().notNull().default([]),
    /** Planner bookings/changes below this amount apply without a Host (default 0 = always ask). */
    autoApproveBelowPaise: bigint("auto_approve_below_paise", { mode: "number" }).notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [unique("service_types_key_uq").on(t.eventId, t.systemKey), unique("service_types_event_uq").on(t.id, t.eventId)],
);

export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    functionId: uuid("function_id").notNull(),
    serviceTypeId: uuid("service_type_id").notNull(),
    /** Optional label, e.g. "Bar" for a second Catering service. */
    name: text("name"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    brief: text("brief"),
    payer: jsonb("payer").$type<Payer>(),
    approvalState: approvalState("approval_state").notNull().default("approved"),
    cancelledAt: ts("cancelled_at"),
    version: integer("version").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("services_fn_idx").on(t.functionId),
    unique("services_event_uq").on(t.id, t.eventId),
    foreignKey({ name: "services_fn_fk", columns: [t.functionId, t.eventId], foreignColumns: [functions.id, functions.eventId] }),
    foreignKey({ name: "services_type_fk", columns: [t.serviceTypeId, t.eventId], foreignColumns: [serviceTypes.id, serviceTypes.eventId] }),
  ],
);

export const requirements = pgTable(
  "requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").notNull(),
    title: text("title").notNull(),
    quantity: integer("quantity"),
    unit: text("unit"),
    specs: text("specs"),
    /** Wall-clock overrides; null = the function's own time/venue. */
    startsAt: wallClock("starts_at"),
    endsAt: wallClock("ends_at"),
    venue: text("venue"),
    estimatePaise: bigint("estimate_paise", { mode: "number" }),
    priority: requirementPriority("priority").notNull().default("must"),
    payer: jsonb("payer").$type<Payer>(),
    approvalState: approvalState("approval_state").notNull().default("approved"),
    lifecycle: requirementLifecycle("lifecycle").notNull().default("open"),
    deliveredAt: ts("delivered_at"),
    version: integer("version").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("requirements_service_idx").on(t.serviceId, t.sortOrder),
    unique("requirements_event_uq").on(t.id, t.eventId),
    unique("requirements_service_uq").on(t.id, t.serviceId),
    foreignKey({ name: "requirements_service_fk", columns: [t.serviceId, t.eventId], foreignColumns: [services.id, services.eventId] }).onDelete("cascade"),
  ],
);

/** Vendor directory (VND-01). PAN and bank details are encrypted (ADR-0019). */
export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    gstin: text("gstin"),
    panEnc: text("pan_enc"),
    panLast4: text("pan_last4"),
    bankEnc: text("bank_enc"),
    bankLast4: text("bank_last4"),
    rating: integer("rating"),
    ratingNote: text("rating_note"),
    notes: text("notes"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("vendors_event_idx").on(t.eventId, t.name), unique("vendors_event_uq").on(t.id, t.eventId)],
);

export const vendorServiceTypes = pgTable(
  "vendor_service_types",
  {
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    serviceTypeId: uuid("service_type_id")
      .notNull()
      .references(() => serviceTypes.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.vendorId, t.serviceTypeId] })],
);

/** A request to one vendor to quote for one or more services (VND-02). */
export const quoteRequests = pgTable(
  "quote_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull(),
    dueDate: date("due_date"),
    message: text("message"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    closedAt: ts("closed_at"),
  },
  (t) => [
    index("quote_requests_event_idx").on(t.eventId, t.createdAt),
    foreignKey({ name: "quote_requests_vendor_fk", columns: [t.vendorId, t.eventId], foreignColumns: [vendors.id, vendors.eventId] }).onDelete("cascade"),
  ],
);

export const quoteRequestServices = pgTable(
  "quote_request_services",
  {
    requestId: uuid("request_id")
      .notNull()
      .references(() => quoteRequests.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.serviceId] }), index("quote_request_services_service_idx").on(t.serviceId)],
);

/** A vendor's quote; revisions are new rows with the same root and a higher version (VND-07). */
export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull(),
    requestId: uuid("request_id").references(() => quoteRequests.id, { onDelete: "set null" }),
    rootId: uuid("root_id").notNull(),
    version: integer("version").notNull().default(1),
    vendorRef: text("vendor_ref"),
    receivedOn: date("received_on"),
    validUntil: date("valid_until"),
    terms: text("terms"),
    taxType: taxType("tax_type").notNull().default("none"),
    /** Package conditions (VND-04). */
    allOrNothing: boolean("all_or_nothing").notNull().default(false),
    minFunctions: integer("min_functions"),
    declinedAt: ts("declined_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("quotes_root_version_uq").on(t.rootId, t.version),
    unique("quotes_event_uq").on(t.id, t.eventId),
    index("quotes_event_idx").on(t.eventId, t.vendorId),
    foreignKey({ name: "quotes_vendor_fk", columns: [t.vendorId, t.eventId], foreignColumns: [vendors.id, vendors.eventId] }).onDelete("cascade"),
  ],
);

export const quoteLines = pgTable(
  "quote_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    scope: quoteLineScope("scope").notNull(),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id").references(() => requirements.id, { onDelete: "cascade" }),
    description: text("description"),
    /** Quantity this line covers (partial share of the requirement), if any. */
    quantity: integer("quantity"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    gstRateBps: integer("gst_rate_bps").notNull().default(0),
    /** Package discount that applies only when the package conditions hold (VND-04). */
    conditional: boolean("conditional").notNull().default(false),
    /** Manual split of a package-level line over services: { serviceId: paise }. Null = proportional. */
    allocation: jsonb("allocation").$type<Record<string, number>>(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("quote_lines_quote_idx").on(t.quoteId, t.sortOrder),
    index("quote_lines_service_idx").on(t.serviceId),
    check(
      "quote_lines_scope_ck",
      sql`(${t.scope} = 'requirement' and ${t.requirementId} is not null and ${t.serviceId} is not null) or (${t.scope} = 'service' and ${t.requirementId} is null and ${t.serviceId} is not null) or (${t.scope} = 'package' and ${t.requirementId} is null and ${t.serviceId} is null)`,
    ),
    foreignKey({ name: "quote_lines_req_fk", columns: [t.requirementId, t.serviceId], foreignColumns: [requirements.id, requirements.serviceId] }).onDelete("cascade"),
  ],
);

/** An accepted quote (or part of one): VND-06. One quote makes at most one live booking. */
export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull(),
    quoteId: uuid("quote_id").references(() => quotes.id),
    status: bookingStatus("status").notNull().default("pending_approval"),
    /** Snapshots of the agreed amounts (pre-GST and GST), in paise. */
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull().default(0),
    gstPaise: bigint("gst_paise", { mode: "number" }).notNull().default(0),
    /** Contract key terms (VND-09). */
    cancellationPolicy: text("cancellation_policy"),
    deliverables: text("deliverables"),
    notes: text("notes"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    confirmedAt: ts("confirmed_at"),
    cancelledAt: ts("cancelled_at"),
    cancelReason: text("cancel_reason"),
  },
  (t) => [
    index("bookings_event_idx").on(t.eventId, t.status),
    unique("bookings_event_uq").on(t.id, t.eventId),
    uniqueIndex("bookings_live_quote_uq").on(t.quoteId).where(sql`status <> 'cancelled' and quote_id is not null`),
    foreignKey({ name: "bookings_vendor_fk", columns: [t.vendorId, t.eventId], foreignColumns: [vendors.id, vendors.eventId] }),
  ],
);

/** A vendor's share of a requirement (or a service-level amount) under a booking (SVC-06). */
export const fulfilments = pgTable(
  "fulfilments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    requirementId: uuid("requirement_id").references(() => requirements.id),
    quoteLineId: uuid("quote_line_id").references(() => quoteLines.id, { onDelete: "set null" }),
    quantity: integer("quantity"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    gstPaise: bigint("gst_paise", { mode: "number" }).notNull().default(0),
    cancelledAt: ts("cancelled_at"),
  },
  (t) => [index("fulfilments_booking_idx").on(t.bookingId), index("fulfilments_req_idx").on(t.requirementId), index("fulfilments_service_idx").on(t.serviceId)],
);

/** Costs not tied to a service, e.g. return gifts (BGT-02). */
export const budgetLines = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").notNull(),
    functionId: uuid("function_id").references(() => functions.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    estimatePaise: bigint("estimate_paise", { mode: "number" }).notNull().default(0),
    payer: jsonb("payer").$type<Payer>(),
    notes: text("notes"),
    approvalState: approvalState("approval_state").notNull().default("approved"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("budget_lines_event_idx").on(t.eventId),
    foreignKey({ name: "budget_lines_cat_fk", columns: [t.categoryId, t.eventId], foreignColumns: [serviceTypes.id, serviceTypes.eventId] }),
  ],
);

/** Payment schedule of a booking (PAY-02). Active only when the booking is confirmed. */
export const paymentMilestones = pgTable(
  "payment_milestones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    kind: milestoneKind("kind").notNull().default("milestone"),
    label: text("label"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    dueDate: date("due_date"),
    payer: jsonb("payer").$type<Payer>(),
    sortOrder: integer("sort_order").notNull().default(0),
    lastRemindedOn: date("last_reminded_on"),
  },
  (t) => [index("payment_milestones_booking_idx").on(t.bookingId, t.sortOrder)],
);

/** Vendor invoices with GST (PAY-01). Amounts are as printed on the invoice. */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    number: text("number").notNull(),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date"),
    supplierGstin: text("supplier_gstin"),
    taxType: taxType("tax_type").notNull().default("none"),
    subtotalPaise: bigint("subtotal_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull().default(0),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull().default(0),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull().default(0),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("invoices_number_uq").on(t.eventId, t.vendorId, t.number),
    foreignKey({ name: "invoices_vendor_fk", columns: [t.vendorId, t.eventId], foreignColumns: [vendors.id, vendors.eventId] }),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    /** Service the line is for (null = spread over the booking's services). */
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    hsnSac: text("hsn_sac"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    gstRateBps: integer("gst_rate_bps").notNull().default(0),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

/** Payments made outside the app (PAY-03). A Planner's payment waits for a Host to confirm. */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id").references(() => bookings.id),
    budgetLineId: uuid("budget_line_id").references(() => budgetLines.id),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    paidOn: date("paid_on").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    mode: paymentMode("mode").notNull(),
    reference: text("reference"),
    payer: jsonb("payer").$type<Payer>(),
    notes: text("notes"),
    state: paymentState("state").notNull().default("recorded"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: ts("confirmed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("payments_booking_idx").on(t.bookingId, t.state),
    index("payments_event_idx").on(t.eventId, t.paidOn),
    check("payments_amount_ck", sql`${t.amountPaise} > 0`),
    check("payments_target_ck", sql`(${t.bookingId} is null) <> (${t.budgetLineId} is null)`),
  ],
);

/** Uploaded files (contracts, quotes, invoices, receipts). Bytes live in document_blobs (ADR-0018). */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: documentKind("kind").notNull().default("other"),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id").references(() => services.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("documents_event_idx").on(t.eventId, t.createdAt)],
);

export const documentBlobs = pgTable("document_blobs", {
  documentId: uuid("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
});

/** Key dates in a contract (VND-09) become tasks so the daily task reminders cover them. */
export const bookingKeyDates = pgTable(
  "booking_key_dates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    date: date("date").notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  },
  (t) => [index("booking_key_dates_booking_idx").on(t.bookingId)],
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
export type RsvpStatus = (typeof rsvpStatus.enumValues)[number];
export type GuestTravel = typeof guestTravel.$inferSelect;
export type Website = typeof websites.$inferSelect;
export type TransferRun = typeof transferRuns.$inferSelect;
export type TransferKind = (typeof transferKind.enumValues)[number];
export type Hotel = typeof hotels.$inferSelect;
export type RoomBlock = typeof roomBlocks.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type SeatingTable = typeof seatingTables.$inferSelect;
export type RunSheetItem = typeof runSheetItems.$inferSelect;
export type RunItemStatus = (typeof runItemStatus.enumValues)[number];
export type ServiceType = typeof serviceTypes.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Requirement = typeof requirements.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type QuoteRequest = typeof quoteRequests.$inferSelect;
export type Quote = typeof quotes.$inferSelect;
export type QuoteLine = typeof quoteLines.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type Fulfilment = typeof fulfilments.$inferSelect;
export type BudgetLine = typeof budgetLines.$inferSelect;
export type PaymentMilestone = typeof paymentMilestones.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceLine = typeof invoiceLines.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ApprovalState = (typeof approvalState.enumValues)[number];
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type TaxType = (typeof taxType.enumValues)[number];
export type PaymentMode = (typeof paymentMode.enumValues)[number];
