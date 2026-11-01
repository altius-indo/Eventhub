CREATE TABLE "gallery_ready_notices" (
	"function_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"status" text NOT NULL,
	"channel" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_items" DROP CONSTRAINT "media_items_reservation_id_storage_reservations_id_fk";
--> statement-breakpoint
ALTER TABLE "gallery_settings" ADD COLUMN "sweep_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "media_items" ADD COLUMN "share_key" text;--> statement-breakpoint
ALTER TABLE "gallery_ready_notices" ADD CONSTRAINT "gallery_ready_notices_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_ready_notices" ADD CONSTRAINT "gallery_ready_notices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;