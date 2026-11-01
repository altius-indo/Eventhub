ALTER TABLE "events" ADD COLUMN "logo_key" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "logo_bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_event_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_event_id_events_id_fk" FOREIGN KEY ("last_event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;