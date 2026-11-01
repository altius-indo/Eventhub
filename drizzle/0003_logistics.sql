CREATE TYPE "public"."checkin_source" AS ENUM('scan', 'manual', 'walk_in');--> statement-breakpoint
CREATE TYPE "public"."run_item_status" AS ENUM('pending', 'in_progress', 'done');--> statement-breakpoint
CREATE TYPE "public"."transfer_kind" AS ENUM('pickup', 'drop', 'shuttle');--> statement-breakpoint
CREATE TABLE "check_ins" (
	"event_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"checked_in_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_by" uuid,
	"source" "checkin_source" NOT NULL,
	"uninvited" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hotels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"map_url" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_assignments" (
	"event_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_type" text NOT NULL,
	"max_occupancy" integer DEFAULT 2 NOT NULL,
	"blocked_count" integer NOT NULL,
	"rate_paise" bigint,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"label" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_sheet_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"starts_at" timestamp NOT NULL,
	"duration_min" integer,
	"title" text NOT NULL,
	"owner_user_id" uuid,
	"owner_name" text,
	"owner_phone" text,
	"location" text,
	"notes" text,
	"time_locked" boolean DEFAULT false NOT NULL,
	"status" "run_item_status" DEFAULT 'pending' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seat_assignments" (
	"event_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seating_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "seating_tables_fn_uq" UNIQUE("id","function_id")
);
--> statement-breakpoint
CREATE TABLE "transfer_passengers" (
	"event_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "transfer_kind" NOT NULL,
	"function_id" uuid,
	"departs_at" timestamp NOT NULL,
	"from_place" text NOT NULL,
	"to_place" text NOT NULL,
	"vehicle" text,
	"driver_name" text,
	"driver_phone" text,
	"capacity" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "share_transfers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "share_rooms" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "share_seating" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_assignments" ADD CONSTRAINT "room_assignments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_assignments" ADD CONSTRAINT "room_assignments_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_assignments" ADD CONSTRAINT "room_assignments_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_block_id_room_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."room_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sheet_items" ADD CONSTRAINT "run_sheet_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sheet_items" ADD CONSTRAINT "run_sheet_items_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sheet_items" ADD CONSTRAINT "run_sheet_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_table_fk" FOREIGN KEY ("table_id","function_id") REFERENCES "public"."seating_tables"("id","function_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_invite_fk" FOREIGN KEY ("function_id","guest_id") REFERENCES "public"."function_invites"("function_id","guest_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_tables" ADD CONSTRAINT "seating_tables_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seating_tables" ADD CONSTRAINT "seating_tables_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_passengers" ADD CONSTRAINT "transfer_passengers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_passengers" ADD CONSTRAINT "transfer_passengers_run_id_transfer_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."transfer_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_passengers" ADD CONSTRAINT "transfer_passengers_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_runs" ADD CONSTRAINT "transfer_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_runs" ADD CONSTRAINT "transfer_runs_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "check_ins_pk" ON "check_ins" USING btree ("function_id","guest_id");--> statement-breakpoint
CREATE INDEX "check_ins_event_idx" ON "check_ins" USING btree ("event_id","function_id");--> statement-breakpoint
CREATE INDEX "hotels_event_idx" ON "hotels" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_assignments_pk" ON "room_assignments" USING btree ("room_id","guest_id");--> statement-breakpoint
CREATE INDEX "room_assignments_guest_idx" ON "room_assignments" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "room_blocks_hotel_idx" ON "room_blocks" USING btree ("hotel_id");--> statement-breakpoint
CREATE INDEX "rooms_block_idx" ON "rooms" USING btree ("block_id","sort_order");--> statement-breakpoint
CREATE INDEX "run_sheet_items_fn_idx" ON "run_sheet_items" USING btree ("function_id","starts_at","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "seat_assignments_pk" ON "seat_assignments" USING btree ("function_id","guest_id");--> statement-breakpoint
CREATE INDEX "seat_assignments_table_idx" ON "seat_assignments" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "seating_tables_fn_idx" ON "seating_tables" USING btree ("function_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_passengers_pk" ON "transfer_passengers" USING btree ("run_id","guest_id");--> statement-breakpoint
CREATE INDEX "transfer_passengers_guest_idx" ON "transfer_passengers" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "transfer_runs_event_idx" ON "transfer_runs" USING btree ("event_id","departs_at");