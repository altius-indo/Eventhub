CREATE TABLE "event_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text NOT NULL,
	"created_month" text,
	"last_function_month" text,
	"counts" jsonb NOT NULL,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_storage_overrides" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"storage_bytes" bigint,
	"guest_items" integer,
	"guest_bytes" bigint
);
--> statement-breakpoint
CREATE TABLE "guest_erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"household_id" uuid,
	"household_name" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"note" text,
	"recorded_by" uuid,
	"processed_by" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_notices" (
	"event_id" uuid NOT NULL,
	"days" integer NOT NULL,
	"deletion_date" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_notices_event_id_days_pk" PRIMARY KEY("event_id","days")
);
--> statement-breakpoint
CREATE TABLE "storage_deletions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_household_usage" (
	"event_id" uuid NOT NULL,
	"household_id" uuid PRIMARY KEY NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_usage" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"warned80_at" timestamp with time zone,
	"warned95_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "event_storage_overrides" ADD CONSTRAINT "event_storage_overrides_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_erasure_requests" ADD CONSTRAINT "guest_erasure_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_erasure_requests" ADD CONSTRAINT "guest_erasure_requests_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_erasure_requests" ADD CONSTRAINT "guest_erasure_requests_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_erasure_requests" ADD CONSTRAINT "guest_erasure_requests_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_notices" ADD CONSTRAINT "retention_notices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_household_usage" ADD CONSTRAINT "storage_household_usage_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_household_usage" ADD CONSTRAINT "storage_household_usage_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_erasure_event_idx" ON "guest_erasure_requests" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "storage_deletions_due_idx" ON "storage_deletions" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "storage_household_usage_event_idx" ON "storage_household_usage" USING btree ("event_id");