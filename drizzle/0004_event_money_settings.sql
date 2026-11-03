ALTER TABLE "approval_requests" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "function_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "last_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "place_of_supply" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "payment_reminders_to" text DEFAULT 'hosts_planners' NOT NULL;--> statement-breakpoint
CREATE INDEX "approval_entity_idx" ON "approval_requests" USING btree ("entity_type","entity_id");--> statement-breakpoint
ALTER TABLE "functions" ADD CONSTRAINT "functions_event_uq" UNIQUE("id","event_id");