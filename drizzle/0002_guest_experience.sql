CREATE TYPE "public"."rsvp_status" AS ENUM('attending', 'maybe', 'declined');--> statement-breakpoint
CREATE TYPE "public"."site_visibility" AS ENUM('unlisted', 'passcode', 'public');--> statement-breakpoint
CREATE TYPE "public"."travel_mode" AS ENUM('flight', 'train', 'bus', 'car', 'other');--> statement-breakpoint
CREATE TABLE "guest_travel" (
	"guest_id" uuid PRIMARY KEY NOT NULL,
	"arrival_mode" "travel_mode",
	"arrival_number" text,
	"arrival_at" timestamp,
	"arrival_point" text,
	"needs_pickup" boolean DEFAULT false NOT NULL,
	"departure_mode" "travel_mode",
	"departure_number" text,
	"departure_at" timestamp,
	"departure_point" text,
	"needs_drop" boolean DEFAULT false NOT NULL,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_guest" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rsvps" (
	"function_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"status" "rsvp_status" NOT NULL,
	"recorded_by" uuid,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"visibility" "site_visibility" DEFAULT 'unlisted' NOT NULL,
	"passcode_hash" text,
	"passcode_version" integer DEFAULT 1 NOT NULL,
	"draft" jsonb NOT NULL,
	"published" jsonb,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "rsvp_deadline" date;--> statement-breakpoint
ALTER TABLE "functions" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "functions" ADD COLUMN "venue_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "added_by_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "plus_ones_allowed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "link_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "link_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "link_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "rsvp_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guest_travel" ADD CONSTRAINT "guest_travel_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsvps" ADD CONSTRAINT "rsvps_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_images" ADD CONSTRAINT "site_images_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_events_idx" ON "rate_events" USING btree ("kind","key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rsvps_pk" ON "rsvps" USING btree ("function_id","guest_id");--> statement-breakpoint
CREATE INDEX "rsvps_guest_idx" ON "rsvps" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "site_images_event_idx" ON "site_images" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "websites_event_uq" ON "websites" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "websites_slug_uq" ON "websites" USING btree ("slug");