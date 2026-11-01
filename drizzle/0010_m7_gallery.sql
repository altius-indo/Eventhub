CREATE TYPE "public"."album_kind" AS ENUM('delivery', 'family', 'guest');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('photo', 'video');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('uploading', 'processing', 'pending', 'approved', 'hidden', 'failed');--> statement-breakpoint
CREATE TYPE "public"."removal_status" AS ENUM('open', 'removed', 'kept');--> statement-breakpoint
CREATE TYPE "public"."uploader_kind" AS ENUM('member', 'vendor', 'household');--> statement-breakpoint
CREATE TABLE "album_selection_items" (
	"event_id" uuid NOT NULL,
	"selection_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "album_selection_items_selection_id_media_id_pk" PRIMARY KEY("selection_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "album_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_id" uuid,
	"vendor_id" uuid,
	"title" text NOT NULL,
	"note" text,
	"deadline" date,
	"shared_at" timestamp with time zone,
	"shared_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gallery_albums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"kind" "album_kind" NOT NULL,
	"booking_id" uuid,
	"vendor_id" uuid,
	"title" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gallery_settings" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"guest_uploads" boolean DEFAULT false NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"guest_originals" boolean DEFAULT false NOT NULL,
	"reactions" boolean DEFAULT true NOT NULL,
	"watermark_text" text,
	"swept_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"body" text NOT NULL,
	"hidden_at" timestamp with time zone,
	"hidden_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_favourites" (
	"event_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_favourites_media_id_user_id_pk" PRIMARY KEY("media_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "media_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"album_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"uploader_kind" "uploader_kind" NOT NULL,
	"user_id" uuid,
	"vendor_id" uuid,
	"household_id" uuid,
	"client_key" uuid NOT NULL,
	"kind" "media_kind" NOT NULL,
	"mime" text NOT NULL,
	"filename" text NOT NULL,
	"original_key" text NOT NULL,
	"original_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"reservation_id" uuid,
	"thumb_key" text,
	"web_key" text,
	"width" integer,
	"height" integer,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "media_status" DEFAULT 'uploading' NOT NULL,
	"preview_error" text,
	"upload_expires_at" timestamp with time zone,
	"processing_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"highlight" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_likes" (
	"event_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_likes_media_id_household_id_pk" PRIMARY KEY("media_id","household_id")
);
--> statement-breakpoint
CREATE TABLE "media_removal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"media_id" uuid,
	"household_id" uuid,
	"reason" text,
	"status" "removal_status" DEFAULT 'open' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "album_selection_items" ADD CONSTRAINT "album_selection_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_selection_items" ADD CONSTRAINT "album_selection_items_selection_id_album_selections_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."album_selections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_selection_items" ADD CONSTRAINT "album_selection_items_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_selections" ADD CONSTRAINT "album_selections_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_selections" ADD CONSTRAINT "album_selections_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_selections" ADD CONSTRAINT "album_selections_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_selections" ADD CONSTRAINT "album_selections_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_selections" ADD CONSTRAINT "album_selections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_albums" ADD CONSTRAINT "gallery_albums_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_albums" ADD CONSTRAINT "gallery_albums_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_albums" ADD CONSTRAINT "gallery_albums_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_albums" ADD CONSTRAINT "gallery_albums_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_albums" ADD CONSTRAINT "gallery_albums_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_albums" ADD CONSTRAINT "gallery_albums_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_settings" ADD CONSTRAINT "gallery_settings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_comments" ADD CONSTRAINT "media_comments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_comments" ADD CONSTRAINT "media_comments_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_comments" ADD CONSTRAINT "media_comments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_comments" ADD CONSTRAINT "media_comments_hidden_by_users_id_fk" FOREIGN KEY ("hidden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_favourites" ADD CONSTRAINT "media_favourites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_favourites" ADD CONSTRAINT "media_favourites_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_favourites" ADD CONSTRAINT "media_favourites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_album_id_gallery_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."gallery_albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_reservation_id_storage_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."storage_reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_likes" ADD CONSTRAINT "media_likes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_likes" ADD CONSTRAINT "media_likes_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_likes" ADD CONSTRAINT "media_likes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_removal_requests" ADD CONSTRAINT "media_removal_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_removal_requests" ADD CONSTRAINT "media_removal_requests_media_id_media_items_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_removal_requests" ADD CONSTRAINT "media_removal_requests_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_removal_requests" ADD CONSTRAINT "media_removal_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "album_selection_items_media_idx" ON "album_selection_items" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "album_selections_event_idx" ON "album_selections" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "album_selections_vendor_idx" ON "album_selections" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "gallery_albums_fn_idx" ON "gallery_albums" USING btree ("event_id","function_id","sort_order");--> statement-breakpoint
CREATE INDEX "gallery_albums_vendor_idx" ON "gallery_albums" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "media_comments_media_idx" ON "media_comments" USING btree ("media_id","created_at");--> statement-breakpoint
CREATE INDEX "media_favourites_user_idx" ON "media_favourites" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_items_client_uq" ON "media_items" USING btree ("event_id","client_key");--> statement-breakpoint
CREATE INDEX "media_items_album_idx" ON "media_items" USING btree ("event_id","album_id","taken_at","id");--> statement-breakpoint
CREATE INDEX "media_items_fn_idx" ON "media_items" USING btree ("event_id","function_id","status");--> statement-breakpoint
CREATE INDEX "media_items_household_idx" ON "media_items" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "media_items_work_idx" ON "media_items" USING btree ("status") WHERE status in ('uploading', 'processing');--> statement-breakpoint
CREATE INDEX "media_removal_event_idx" ON "media_removal_requests" USING btree ("event_id","status","created_at");