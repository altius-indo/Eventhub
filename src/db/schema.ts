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
  type AnyPgColumn,
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
  /** The event the user last opened (lands there after login). Membership is re-checked on use. */
  lastEventId: uuid("last_event_id").references((): AnyPgColumn => events.id, { onDelete: "set null" }),
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
  /** Caterer headcount change alerts (RSV-06): whichever of % or absolute change triggers first. */
  headcountAlertPct: integer("headcount_alert_pct").notNull().default(5),
  headcountAlertAbs: integer("headcount_alert_abs").notNull().default(20),
  /** Optional event logo: a 256px square WebP in the object store (`events/<id>/branding/...`). */
  logoKey: text("logo_key"),
  logoBytes: integer("logo_bytes").notNull().default(0),
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
    /** Preferred channel for guest messages (MSG-03); null = WhatsApp, then email, then SMS. */
    preferredChannel: text("preferred_channel"),
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
  theme: "ornate" | "traditional" | "modern" | "minimal";
  accent: string;
  monogram: string;
  coverImageId: string | null;
  /** Show the cover uncropped as the page header (artwork that already has the names); hides the duplicate names visually. */
  coverAsHeader?: boolean;
  sections: {
    welcome: { visible: boolean; headline: LocalizedText; message: LocalizedText };
    story: { visible: boolean; title: LocalizedText; body: LocalizedText; imageIds: string[] };
    events: { visible: boolean; title: LocalizedText };
    travel: { visible: boolean; title: LocalizedText; body: LocalizedText };
    faqs: { visible: boolean; title: LocalizedText; items: { q: LocalizedText; a: LocalizedText }[] };
    /** `highlights`: also show the photos the family picked from the event gallery (GAL-05). */
    gallery: { visible: boolean; title: LocalizedText; imageIds: string[]; highlights?: boolean };
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
    /** A booked vendor who owns this item; it then shows in their portal (VND-10). */
    ownerVendorId: uuid("owner_vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    /** External contact (vendor, pandit, DJ…) not in the vendor directory. */
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
    /** Entered by the vendor in the portal (VND-10) rather than by the team. */
    submittedByVendor: boolean("submitted_by_vendor").notNull().default(false),
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
    /** "team" or "vendor" (uploaded in the portal, VND-10). */
    source: text("source").notNull().default("team"),
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

/**
 * Uploaded files (contracts, quotes, invoices, receipts). New bytes live in object storage at
 * `storage_key` (ADR-0030); older rows without a key keep them in document_blobs (ADR-0018).
 */
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
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    giftId: uuid("gift_id").references(() => gifts.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** Object-store key (`events/<eventId>/documents/<id>`); null = bytes in document_blobs. */
    storageKey: text("storage_key"),
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
// Communication — MSG, VND-10, RSV-06/07, GFT, LIM (milestone 6)
// ---------------------------------------------------------------------------

/** A login allowed into one vendor's portal (ADR-0023). Vendors are not event members. */
export const vendorContacts = pgTable(
  "vendor_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").notNull(),
    identifierType: identifierType("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    foreignKey({ name: "vendor_contacts_vendor_fk", columns: [t.vendorId, t.eventId], foreignColumns: [vendors.id, vendors.eventId] }).onDelete("cascade"),
    uniqueIndex("vendor_contacts_open_uq").on(t.vendorId, t.identifierType, t.identifierValue).where(sql`revoked_at IS NULL`),
    index("vendor_contacts_user_idx").on(t.userId),
    index("vendor_contacts_identifier_idx").on(t.identifierType, t.identifierValue),
  ],
);

export const threadKind = pgEnum("thread_kind", ["team", "vendor", "function"]);
export const authorKind = pgEnum("author_kind", ["member", "vendor"]);

/** Chat threads (MSG-01): one team thread, one per vendor, one per function; created lazily. */
export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: threadKind("kind").notNull(),
    vendorId: uuid("vendor_id"),
    functionId: uuid("function_id"),
    lastMessageAt: ts("last_message_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "threads_vendor_fk", columns: [t.vendorId, t.eventId], foreignColumns: [vendors.id, vendors.eventId] }).onDelete("cascade"),
    foreignKey({ name: "threads_fn_fk", columns: [t.functionId, t.eventId], foreignColumns: [functions.id, functions.eventId] }).onDelete("cascade"),
    uniqueIndex("threads_team_uq").on(t.eventId).where(sql`kind = 'team'`),
    uniqueIndex("threads_vendor_uq").on(t.eventId, t.vendorId).where(sql`kind = 'vendor'`),
    uniqueIndex("threads_fn_uq").on(t.eventId, t.functionId).where(sql`kind = 'function'`),
    check(
      "threads_kind_ck",
      sql`(${t.kind} = 'team' and ${t.vendorId} is null and ${t.functionId} is null) or (${t.kind} = 'vendor' and ${t.vendorId} is not null and ${t.functionId} is null) or (${t.kind} = 'function' and ${t.functionId} is not null and ${t.vendorId} is null)`,
    ),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic cursor for polling (ADR-0026). */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    authorKind: authorKind("author_kind").notNull().default("member"),
    body: text("body").notNull(),
    mentionUserIds: uuid("mention_user_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [uniqueIndex("messages_seq_uq").on(t.seq), index("messages_thread_idx").on(t.threadId, t.seq)],
);

export const threadReads = pgTable(
  "thread_reads",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] })],
);

/** In-app notifications (MSG-05). Text is rendered at read time from kind + data (ADR-0029). */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    data: jsonb("data").$type<Record<string, string | number | null>>().notNull().default({}),
    href: text("href"),
    createdAt: createdAt(),
    readAt: ts("read_at"),
    emailedAt: ts("emailed_at"),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt)],
);

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    email: boolean("email").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category] })],
);

export const messageChannel = pgEnum("message_channel", ["whatsapp", "email", "sms"]);
export const broadcastStatus = pgEnum("broadcast_status", ["draft", "queued", "sending", "done", "cancelled"]);

export type BroadcastSegment = {
  sides?: string[];
  tags?: string[];
  functionIds?: string[];
  rsvp?: ("attending" | "maybe" | "declined" | "pending")[];
  travel?: ("needs_pickup" | "self" | "none")[];
  hotelIds?: string[];
  allAdults?: boolean;
};

/** Guest broadcasts (MSG-02). */
export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: jsonb("body").$type<{ en: string; hi?: string }>().notNull(),
    segment: jsonb("segment").$type<BroadcastSegment>().notNull().default({}),
    channels: messageChannel("channels").array().notNull().default(sql`'{whatsapp,email,sms}'::message_channel[]`),
    status: broadcastStatus("status").notNull().default("draft"),
    recipientCount: integer("recipient_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    queuedAt: ts("queued_at"),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("broadcasts_event_idx").on(t.eventId, t.createdAt)],
);

export const outboundStatus = pgEnum("outbound_status", [
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "skipped_optout",
  "skipped_quota",
  "skipped_unavailable",
  "superseded",
]);

/** Outgoing messages and their delivery record (ADR-0024). OTPs don't go through here. */
export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    broadcastId: uuid("broadcast_id").references(() => broadcasts.id, { onDelete: "cascade" }),
    thankYouId: uuid("thank_you_id").references(() => thankYous.id, { onDelete: "cascade" }),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    channel: messageChannel("channel").notNull(),
    toAddress: text("to_address").notNull(),
    locale: text("locale").notNull().default("en"),
    templateKey: text("template_key").notNull(),
    vars: jsonb("vars").$type<Record<string, string | number | null>>().notNull().default({}),
    /** Bulk sends are refused as a whole at 100% of a limit; one-to-one messages still go (LIM-03). */
    bulk: boolean("bulk").notNull().default(false),
    status: outboundStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    lockedUntil: ts("locked_until"),
    fallbackOf: uuid("fallback_of"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
    sentAt: ts("sent_at"),
  },
  (t) => [
    uniqueIndex("outbound_idem_uq").on(t.idempotencyKey),
    index("outbound_due_idx").on(t.nextAttemptAt).where(sql`status = 'queued'`),
    index("outbound_broadcast_idx").on(t.broadcastId, t.status),
    index("outbound_event_idx").on(t.eventId, t.createdAt),
  ],
);

/** Messages used and reserved per event and channel (LIM-01..03, ADR-0025). */
export const messageUsage = pgTable(
  "message_usage",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channel: messageChannel("channel").notNull(),
    used: integer("used").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    warned80At: ts("warned80_at"),
    warned95At: ts("warned95_at"),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.channel] })],
);

/** Platform configuration (§4.1 defaults), e.g. key "limits". */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const eventLimitOverrides = pgTable(
  "event_limit_overrides",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channel: messageChannel("channel").notNull(),
    limit: integer("limit").notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.channel] })],
);

/** Guests who asked not to receive broadcasts on a channel (MSG-03 opt-out, DPDP consent). */
export const messageOptOuts = pgTable(
  "message_opt_outs",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channel: messageChannel("channel").notNull(),
    address: text("address").notNull(),
    source: text("source").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.channel, t.address] })],
);

export const giftType = pgEnum("gift_type", ["cash", "upi", "cheque", "item", "gold", "voucher", "other"]);
export const giftReceivedFor = pgEnum("gift_received_for", ["bride", "groom", "couple", "parents", "other"]);
export const giftSource = pgEnum("gift_source", ["manual", "envelope", "import"]);

/** Gift register (GFT-01). Private to Hosts and Planners with gift access (GFT-07). */
export const gifts = pgTable(
  "gifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "set null" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),
    /** Free-text giver when not on the guest list (or after the guest was erased). */
    giverName: text("giver_name"),
    type: giftType("type").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }),
    itemDescription: text("item_description"),
    estValuePaise: bigint("est_value_paise", { mode: "number" }),
    functionId: uuid("function_id").references(() => functions.id, { onDelete: "set null" }),
    receivedFor: giftReceivedFor("received_for").notNull().default("couple"),
    receivedForNote: text("received_for_note"),
    envelopeNo: text("envelope_no"),
    receivedOn: date("received_on"),
    notes: text("notes"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    source: giftSource("source").notNull().default("manual"),
    /** Offline envelope entries carry a client-made id so retries are stored once (ADR-0027). */
    clientKey: uuid("client_key"),
    importId: uuid("import_id"),
    handoverId: uuid("handover_id"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gifts_client_key_uq").on(t.eventId, t.clientKey).where(sql`client_key IS NOT NULL`),
    index("gifts_household_idx").on(t.eventId, t.householdId),
    index("gifts_fn_collector_idx").on(t.eventId, t.functionId, t.recordedBy),
    check("gifts_giver_ck", sql`${t.householdId} is not null or ${t.giverName} is not null`),
  ],
);

/** Cash hand-over per collector and function (GFT-03). */
export const cashHandovers = pgTable(
  "cash_handovers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    functionId: uuid("function_id").references(() => functions.id, { onDelete: "set null" }),
    collectorUserId: uuid("collector_user_id").references(() => users.id, { onDelete: "set null" }),
    recordedTotalPaise: bigint("recorded_total_paise", { mode: "number" }).notNull(),
    countedPaise: bigint("counted_paise", { mode: "number" }).notNull(),
    handedToUserId: uuid("handed_to_user_id").references(() => users.id, { onDelete: "set null" }),
    handedToName: text("handed_to_name"),
    handedAt: ts("handed_at").notNull().defaultNow(),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("cash_handovers_event_idx").on(t.eventId, t.functionId)],
);

export type GiftImportRow = {
  raw: Record<string, string>;
  giverName: string;
  amountPaise: number | null;
  item: string | null;
  envelopeNo: string | null;
  functionId: string | null;
  householdId: string | null;
  decision: "match" | "free_text" | "skip";
  error?: string;
};

export const giftImports = pgTable("gift_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  rows: jsonb("rows").$type<GiftImportRow[]>().notNull(),
  committedAt: ts("committed_at"),
  createdAt: createdAt(),
});

/** Thank-you note templates per language (GFT-09). Merge fields never include amounts. */
export const thankYouTemplates = pgTable("thank_you_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  locale: text("locale").notNull().default("en"),
  name: text("name").notNull(),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

export const thankYouStatus = pgEnum("thank_you_status", ["not_started", "drafted", "sent", "not_needed"]);
export const thankYouChannel = pgEnum("thank_you_channel", ["whatsapp", "email", "sms", "printed", "in_person"]);

/** Thank-you tracker per household (GFT-08). No row = not started. */
export const thankYous = pgTable(
  "thank_yous",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    status: thankYouStatus("status").notNull().default("not_started"),
    channel: thankYouChannel("channel"),
    templateId: uuid("template_id").references(() => thankYouTemplates.id, { onDelete: "set null" }),
    draftText: text("draft_text"),
    sentAt: ts("sent_at"),
    sentBy: uuid("sent_by").references(() => users.id, { onDelete: "set null" }),
    version: integer("version").notNull().default(1),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("thank_yous_household_uq").on(t.householdId), index("thank_yous_event_idx").on(t.eventId, t.status)],
);

export type HeadcountSnapshot = {
  confirmed: number;
  maybe: number;
  pending: number;
  adults: number;
  children: number;
  infants: number;
  diet: Record<string, number>;
  allergies: number;
};

/** What a caterer last saw/acknowledged, and the final-guarantee lock (RSV-06/07, ADR-0028). */
export const catererHeadcountState = pgTable(
  "caterer_headcount_state",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    baseline: jsonb("baseline").$type<HeadcountSnapshot>(),
    baselineTotal: integer("baseline_total"),
    baselineAt: ts("baseline_at"),
    ackedAt: ts("acked_at"),
    ackedBy: uuid("acked_by").references(() => users.id, { onDelete: "set null" }),
    lastAlertedTotal: integer("last_alerted_total"),
    lockAt: ts("lock_at"),
    lockedSnapshot: jsonb("locked_snapshot").$type<HeadcountSnapshot>(),
    frozenAt: ts("frozen_at"),
    releasedAt: ts("released_at"),
    releasedBy: uuid("released_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.functionId] })],
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
export type VendorContact = typeof vendorContacts.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type Broadcast = typeof broadcasts.$inferSelect;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type MessageChannel = (typeof messageChannel.enumValues)[number];
export type Gift = typeof gifts.$inferSelect;
export type CashHandover = typeof cashHandovers.$inferSelect;
export type ThankYou = typeof thankYous.$inferSelect;
export type ThankYouTemplate = typeof thankYouTemplates.$inferSelect;

// [M7 storage]
// ---------------------------------------------------------------------------
// Object storage quota, retention and deletion — EVT-07..09, LIM-01/03 (milestone 7)
// ---------------------------------------------------------------------------

/** Bytes stored per event (LIM-01/03). `reserved_bytes` covers uploads in flight. */
export const storageUsage = pgTable("storage_usage", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
  warned80At: ts("warned80_at"),
  warned95At: ts("warned95_at"),
  reconciledAt: ts("reconciled_at"),
});

/** Guest uploads per household (§4.1: 300 items / 5 GB by default). Includes reservations. */
export const storageHouseholdUsage = pgTable(
  "storage_household_usage",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .primaryKey()
      .references(() => households.id, { onDelete: "cascade" }),
    items: integer("items").notNull().default(0),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("storage_household_usage_event_idx").on(t.eventId)],
);

/**
 * Space held for an upload in flight (LIM-03). The `storage_usage.reserved_bytes` counter is the
 * sum of these rows; a reservation that is never committed or released (abandoned browser upload)
 * expires and is given back by the daily job, and reconcile recomputes the counter from live rows.
 */
export const storageReservations = pgTable(
  "storage_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    items: integer("items").notNull().default(0),
    audience: text("audience").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("storage_reservations_event_idx").on(t.eventId, t.expiresAt), index("storage_reservations_expiry_idx").on(t.expiresAt)],
);

/** App Admin overrides of the storage limits for one event (null = platform default). */
export const eventStorageOverrides = pgTable("event_storage_overrides", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  storageBytes: bigint("storage_bytes", { mode: "number" }),
  guestItems: integer("guest_items"),
  guestBytes: bigint("guest_bytes", { mode: "number" }),
});

/**
 * Object-store prefixes waiting to be deleted (EVT-07/09). Deliberately no event FK: rows must
 * outlive the event they belonged to. Processed by the daily GC job.
 */
export const storageDeletions = pgTable(
  "storage_deletions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    prefix: text("prefix").notNull(),
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("storage_deletions_due_idx").on(t.nextAttemptAt)],
);

/** Anonymised counts kept after an event is purged (EVT-07). No names, no event FK. */
export const eventMetrics = pgTable("event_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Why the event went: "retention" (1 year) or "deleted" (Host/App Admin deletion). */
  reason: text("reason").notNull(),
  /** Month the event was created and the month of its last function (YYYY-MM), for cohorting. */
  createdMonth: text("created_month"),
  lastFunctionMonth: text("last_function_month"),
  counts: jsonb("counts").$type<Record<string, number>>().notNull(),
  purgedAt: ts("purged_at").notNull().defaultNow(),
});

/** Retention reminders already sent (EVT-08: 60, 30 and 7 days before deletion). */
export const retentionNotices = pgTable(
  "retention_notices",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    days: integer("days").notNull(),
    deletionDate: date("deletion_date").notNull(),
    sentAt: ts("sent_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.days] })],
);

/** A guest's request to erase their family's data (EVT-09, DPDP right to erasure). */
export const guestErasureRequests = pgTable(
  "guest_erasure_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "set null" }),
    /** Name at the time of the request, so the log still reads after the family is erased. */
    householdName: text("household_name").notNull(),
    requestedAt: ts("requested_at").notNull(),
    note: text("note"),
    recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
    processedBy: uuid("processed_by").references(() => users.id, { onDelete: "set null" }),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("guest_erasure_event_idx").on(t.eventId, t.createdAt)],
);

export type StorageUsageRow = typeof storageUsage.$inferSelect;
export type StorageReservation = typeof storageReservations.$inferSelect;
export type GuestErasureRequest = typeof guestErasureRequests.$inferSelect;
export type EventMetric = typeof eventMetrics.$inferSelect;

// [M7 gallery]
// ---------------------------------------------------------------------------
// Post-event photo gallery — GAL-01..08, GAL-10, GAL-11 (milestone 7). Bytes live in object
// storage (ADR-0030); rows hold keys, sizes and state. Direct uploads ADR-0031, renditions ADR-0032.
// ---------------------------------------------------------------------------

export const albumKind = pgEnum("album_kind", ["delivery", "family", "guest"]);
export const uploaderKind = pgEnum("uploader_kind", ["member", "vendor", "household"]);
export const mediaKind = pgEnum("media_kind", ["photo", "video"]);
export const mediaStatus = pgEnum("media_status", ["uploading", "processing", "pending", "approved", "hidden", "failed"]);
export const removalStatus = pgEnum("removal_status", ["open", "removed", "kept"]);

/** Per-event gallery switches (GAL-03/04/06/08/10). No row = defaults. */
export const gallerySettings = pgTable("gallery_settings", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  guestUploads: boolean("guest_uploads").notNull().default(false),
  autoApprove: boolean("auto_approve").notNull().default(false),
  guestOriginals: boolean("guest_originals").notNull().default(false),
  reactions: boolean("reactions").notNull().default(true),
  watermarkText: text("watermark_text"),
  /** Last completed orphan-object sweep (daily job). */
  sweptAt: ts("swept_at"),
  /** Progress of the orphan sweep in progress (0 = start; one step per key-prefix chunk). */
  sweepStep: integer("sweep_step").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Albums inside a function (GAL-01). Delivery albums belong to a vendor's booking (GAL-02). */
export const galleryAlbums = pgTable(
  "gallery_albums",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    kind: albumKind("kind").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Visible to guests once released; deliveries stay private to the family until then (GAL-02). */
    releasedAt: ts("released_at"),
    releasedBy: uuid("released_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("gallery_albums_fn_idx").on(t.eventId, t.functionId, t.sortOrder), index("gallery_albums_vendor_idx").on(t.vendorId)],
);

/** One photo or video (GAL-01..06). `taken_at` starts as the upload time and becomes the EXIF time. */
export const mediaItems = pgTable(
  "media_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    albumId: uuid("album_id")
      .notNull()
      .references(() => galleryAlbums.id, { onDelete: "cascade" }),
    functionId: uuid("function_id")
      .notNull()
      .references(() => functions.id, { onDelete: "cascade" }),
    uploaderKind: uploaderKind("uploader_kind").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    /** Chosen by the browser per file, so a retried "begin" resumes instead of duplicating. */
    clientKey: uuid("client_key").notNull(),
    kind: mediaKind("kind").notNull(),
    mime: text("mime").notNull(),
    filename: text("filename").notNull(),
    originalKey: text("original_key").notNull(),
    originalBytes: bigint("original_bytes", { mode: "number" }).notNull().default(0),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
    /**
     * The quota reservation held while uploading. Deliberately no foreign key: when the daily job
     * gives an expired reservation back, the id stays here, and commit/release find it gone and
     * know not to subtract it again (null on old rows means the same).
     */
    reservationId: uuid("reservation_id"),
    thumbKey: text("thumb_key"),
    webKey: text("web_key"),
    /**
     * Full-size JPEG without metadata for guests, made only for non-JPEG photos (HEIC/PNG/WebP);
     * JPEG originals are served to guests with their metadata stripped on the fly (ADR-0032).
     */
    shareKey: text("share_key"),
    width: integer("width"),
    height: integer("height"),
    takenAt: ts("taken_at").notNull().defaultNow(),
    status: mediaStatus("status").notNull().default("uploading"),
    /** Set when no preview could be made (e.g. a HEIC sharp can't read); the original still downloads. */
    previewError: text("preview_error"),
    uploadExpiresAt: ts("upload_expires_at"),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    lockedUntil: ts("locked_until"),
    highlight: boolean("highlight").notNull().default(false),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("media_items_client_uq").on(t.eventId, t.clientKey),
    index("media_items_album_idx").on(t.eventId, t.albumId, t.takenAt, t.id),
    index("media_items_fn_idx").on(t.eventId, t.functionId, t.status),
    index("media_items_household_idx").on(t.householdId),
    index("media_items_work_idx").on(t.status).where(sql`status in ('uploading', 'processing')`),
  ],
);

/** A member's favourites (GAL-07). */
export const mediaFavourites = pgTable(
  "media_favourites",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.userId] }), index("media_favourites_user_idx").on(t.eventId, t.userId)],
);

/** The printed-album selection shared with the photographer (GAL-07). */
export const albumSelections = pgTable(
  "album_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    note: text("note"),
    deadline: date("deadline"),
    sharedAt: ts("shared_at"),
    sharedBy: uuid("shared_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("album_selections_event_idx").on(t.eventId), index("album_selections_vendor_idx").on(t.vendorId)],
);

export const albumSelectionItems = pgTable(
  "album_selection_items",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    selectionId: uuid("selection_id")
      .notNull()
      .references(() => albumSelections.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    addedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.selectionId, t.mediaId] }), index("album_selection_items_media_idx").on(t.mediaId)],
);

/** Guest likes, one per family (GAL-08). */
export const mediaLikes = pgTable(
  "media_likes",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.mediaId, t.householdId] })],
);

/** Guest comments (GAL-08); the family can hide them. */
export const mediaComments = pgTable(
  "media_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => mediaItems.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    hiddenAt: ts("hidden_at"),
    hiddenBy: uuid("hidden_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("media_comments_media_idx").on(t.mediaId, t.createdAt)],
);

/** "Please remove this photo of me" (GAL-04). Kept after the photo goes, for the record. */
export const mediaRemovalRequests = pgTable(
  "media_removal_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id").references(() => mediaItems.id, { onDelete: "set null" }),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "set null" }),
    reason: text("reason"),
    status: removalStatus("status").notNull().default("open"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [index("media_removal_event_idx").on(t.eventId, t.status, t.createdAt)],
);

/**
 * "Photos from <function> are ready" (GAL-11), once per function: `sent` once queued; `quota` when
 * the messaging limit refused it, so Hosts can send it later from the album page.
 */
export const galleryReadyNotices = pgTable("gallery_ready_notices", {
  functionId: uuid("function_id")
    .primaryKey()
    .references(() => functions.id, { onDelete: "cascade" }),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  status: text("status").$type<"sent" | "quota">().notNull(),
  channel: text("channel"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export type GallerySettings = typeof gallerySettings.$inferSelect;
export type GalleryAlbum = typeof galleryAlbums.$inferSelect;
export type MediaItem = typeof mediaItems.$inferSelect;
export type AlbumSelection = typeof albumSelections.$inferSelect;
export type MediaComment = typeof mediaComments.$inferSelect;
export type MediaRemovalRequest = typeof mediaRemovalRequests.$inferSelect;
