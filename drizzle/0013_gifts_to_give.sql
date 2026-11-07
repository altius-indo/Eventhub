CREATE TYPE "public"."gift_item_category" AS ENUM('return_gift', 'family', 'helpers_staff', 'vendor', 'other');--> statement-breakpoint
CREATE TYPE "public"."gift_item_status" AS ENUM('to_buy', 'ordered', 'bought', 'given');--> statement-breakpoint
CREATE TYPE "public"."gift_quantity_mode" AS ENUM('fixed', 'per_family', 'per_guest', 'per_adult');--> statement-breakpoint
CREATE TABLE "gift_item_recipients" (
	"gift_item_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "gift_item_recipients_uq" UNIQUE("gift_item_id","household_id")
);
--> statement-breakpoint
CREATE TABLE "gift_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" "gift_item_category" DEFAULT 'other' NOT NULL,
	"function_id" uuid,
	"give_by" date,
	"quantity_mode" "gift_quantity_mode" DEFAULT 'fixed' NOT NULL,
	"quantity_fixed" integer,
	"quantity_function_id" uuid,
	"quantity_extra" integer DEFAULT 0 NOT NULL,
	"quantity_bought" integer DEFAULT 0 NOT NULL,
	"status" "gift_item_status" DEFAULT 'to_buy' NOT NULL,
	"for_whom" text,
	"unit_cost_paise" bigint,
	"assignee_id" uuid,
	"source" text,
	"notes" text,
	"reminded_on" date,
	"reminded_for" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gift_item_recipients" ADD CONSTRAINT "gift_item_recipients_gift_item_id_gift_items_id_fk" FOREIGN KEY ("gift_item_id") REFERENCES "public"."gift_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_item_recipients" ADD CONSTRAINT "gift_item_recipients_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_item_recipients" ADD CONSTRAINT "gift_item_recipients_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_items" ADD CONSTRAINT "gift_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_items" ADD CONSTRAINT "gift_items_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_items" ADD CONSTRAINT "gift_items_quantity_function_id_functions_id_fk" FOREIGN KEY ("quantity_function_id") REFERENCES "public"."functions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_items" ADD CONSTRAINT "gift_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_items" ADD CONSTRAINT "gift_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_item_recipients_household_idx" ON "gift_item_recipients" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "gift_items_event_status_idx" ON "gift_items" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "gift_items_event_fn_idx" ON "gift_items" USING btree ("event_id","function_id");