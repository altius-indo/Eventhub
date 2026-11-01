CREATE TABLE "storage_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"household_id" uuid,
	"bytes" bigint NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"audience" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_reservations_event_idx" ON "storage_reservations" USING btree ("event_id","expires_at");--> statement-breakpoint
CREATE INDEX "storage_reservations_expiry_idx" ON "storage_reservations" USING btree ("expires_at");