CREATE TYPE "public"."author_kind" AS ENUM('member', 'vendor');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'queued', 'sending', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."gift_received_for" AS ENUM('bride', 'groom', 'couple', 'parents', 'other');--> statement-breakpoint
CREATE TYPE "public"."gift_source" AS ENUM('manual', 'envelope', 'import');--> statement-breakpoint
CREATE TYPE "public"."gift_type" AS ENUM('cash', 'upi', 'cheque', 'item', 'gold', 'voucher', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('whatsapp', 'email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."outbound_status" AS ENUM('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped_optout', 'skipped_quota', 'skipped_unavailable', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."thank_you_channel" AS ENUM('whatsapp', 'email', 'sms', 'printed', 'in_person');--> statement-breakpoint
CREATE TYPE "public"."thank_you_status" AS ENUM('not_started', 'drafted', 'sent', 'not_needed');--> statement-breakpoint
CREATE TYPE "public"."thread_kind" AS ENUM('team', 'vendor', 'function');--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" jsonb NOT NULL,
	"segment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" "message_channel"[] DEFAULT '{whatsapp,email,sms}'::message_channel[] NOT NULL,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cash_handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"function_id" uuid,
	"collector_user_id" uuid,
	"recorded_total_paise" bigint NOT NULL,
	"counted_paise" bigint NOT NULL,
	"handed_to_user_id" uuid,
	"handed_to_name" text,
	"handed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caterer_headcount_state" (
	"event_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"baseline" jsonb,
	"baseline_total" integer,
	"baseline_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"acked_by" uuid,
	"last_alerted_total" integer,
	"lock_at" timestamp with time zone,
	"locked_snapshot" jsonb,
	"frozen_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	CONSTRAINT "caterer_headcount_state_booking_id_function_id_pk" PRIMARY KEY("booking_id","function_id")
);
--> statement-breakpoint
CREATE TABLE "event_limit_overrides" (
	"event_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"limit" integer NOT NULL,
	CONSTRAINT "event_limit_overrides_event_id_channel_pk" PRIMARY KEY("event_id","channel")
);
--> statement-breakpoint
CREATE TABLE "gift_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"created_by" uuid,
	"filename" text NOT NULL,
	"rows" jsonb NOT NULL,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"household_id" uuid,
	"guest_id" uuid,
	"giver_name" text,
	"type" "gift_type" NOT NULL,
	"amount_paise" bigint,
	"item_description" text,
	"est_value_paise" bigint,
	"function_id" uuid,
	"received_for" "gift_received_for" DEFAULT 'couple' NOT NULL,
	"received_for_note" text,
	"envelope_no" text,
	"received_on" date,
	"notes" text,
	"recorded_by" uuid,
	"source" "gift_source" DEFAULT 'manual' NOT NULL,
	"client_key" uuid,
	"import_id" uuid,
	"handover_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gifts_giver_ck" CHECK ("gifts"."household_id" is not null or "gifts"."giver_name" is not null)
);
--> statement-breakpoint
CREATE TABLE "message_opt_outs" (
	"event_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"address" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_opt_outs_event_id_channel_address_pk" PRIMARY KEY("event_id","channel","address")
);
--> statement-breakpoint
CREATE TABLE "message_usage" (
	"event_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"warned80_at" timestamp with time zone,
	"warned95_at" timestamp with time zone,
	CONSTRAINT "message_usage_event_id_channel_pk" PRIMARY KEY("event_id","channel")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"event_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_kind" "author_kind" DEFAULT 'member' NOT NULL,
	"body" text NOT NULL,
	"mention_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"email" boolean NOT NULL,
	CONSTRAINT "notification_prefs_user_id_category_pk" PRIMARY KEY("user_id","category")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid,
	"purpose" text NOT NULL,
	"broadcast_id" uuid,
	"thank_you_id" uuid,
	"household_id" uuid,
	"guest_id" uuid,
	"user_id" uuid,
	"channel" "message_channel" NOT NULL,
	"to_address" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"template_key" text NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bulk" boolean DEFAULT false NOT NULL,
	"status" "outbound_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"fallback_of" uuid,
	"provider" text,
	"provider_message_id" text,
	"error_code" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thank_you_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thank_yous" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"status" "thank_you_status" DEFAULT 'not_started' NOT NULL,
	"channel" "thank_you_channel",
	"template_id" uuid,
	"draft_text" text,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_reads" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "thread_reads_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "thread_kind" NOT NULL,
	"vendor_id" uuid,
	"function_id" uuid,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_kind_ck" CHECK (("threads"."kind" = 'team' and "threads"."vendor_id" is null and "threads"."function_id" is null) or ("threads"."kind" = 'vendor' and "threads"."vendor_id" is not null and "threads"."function_id" is null) or ("threads"."kind" = 'function' and "threads"."function_id" is not null and "threads"."vendor_id" is null))
);
--> statement-breakpoint
CREATE TABLE "vendor_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"identifier_type" "identifier_type" NOT NULL,
	"identifier_value" text NOT NULL,
	"user_id" uuid,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "gift_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "headcount_alert_pct" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "headcount_alert_abs" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "preferred_channel" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "source" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "submitted_by_vendor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "run_sheet_items" ADD COLUMN "owner_vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_collector_user_id_users_id_fk" FOREIGN KEY ("collector_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_handed_to_user_id_users_id_fk" FOREIGN KEY ("handed_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_handovers" ADD CONSTRAINT "cash_handovers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caterer_headcount_state" ADD CONSTRAINT "caterer_headcount_state_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caterer_headcount_state" ADD CONSTRAINT "caterer_headcount_state_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caterer_headcount_state" ADD CONSTRAINT "caterer_headcount_state_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caterer_headcount_state" ADD CONSTRAINT "caterer_headcount_state_acked_by_users_id_fk" FOREIGN KEY ("acked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caterer_headcount_state" ADD CONSTRAINT "caterer_headcount_state_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_limit_overrides" ADD CONSTRAINT "event_limit_overrides_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_imports" ADD CONSTRAINT "gift_imports_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_imports" ADD CONSTRAINT "gift_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gifts" ADD CONSTRAINT "gifts_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_opt_outs" ADD CONSTRAINT "message_opt_outs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_usage" ADD CONSTRAINT "message_usage_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_thank_you_id_thank_yous_id_fk" FOREIGN KEY ("thank_you_id") REFERENCES "public"."thank_yous"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_you_templates" ADD CONSTRAINT "thank_you_templates_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_yous" ADD CONSTRAINT "thank_yous_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_yous" ADD CONSTRAINT "thank_yous_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_yous" ADD CONSTRAINT "thank_yous_template_id_thank_you_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."thank_you_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thank_yous" ADD CONSTRAINT "thank_yous_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_reads" ADD CONSTRAINT "thread_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_vendor_fk" FOREIGN KEY ("vendor_id","event_id") REFERENCES "public"."vendors"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_fn_fk" FOREIGN KEY ("function_id","event_id") REFERENCES "public"."functions"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendor_fk" FOREIGN KEY ("vendor_id","event_id") REFERENCES "public"."vendors"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcasts_event_idx" ON "broadcasts" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_handovers_event_idx" ON "cash_handovers" USING btree ("event_id","function_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gifts_client_key_uq" ON "gifts" USING btree ("event_id","client_key") WHERE client_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "gifts_household_idx" ON "gifts" USING btree ("event_id","household_id");--> statement-breakpoint
CREATE INDEX "gifts_fn_collector_idx" ON "gifts" USING btree ("event_id","function_id","recorded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_seq_uq" ON "messages" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_idem_uq" ON "outbound_messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbound_due_idx" ON "outbound_messages" USING btree ("next_attempt_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "outbound_broadcast_idx" ON "outbound_messages" USING btree ("broadcast_id","status");--> statement-breakpoint
CREATE INDEX "outbound_event_idx" ON "outbound_messages" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thank_yous_household_uq" ON "thank_yous" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "thank_yous_event_idx" ON "thank_yous" USING btree ("event_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_team_uq" ON "threads" USING btree ("event_id") WHERE kind = 'team';--> statement-breakpoint
CREATE UNIQUE INDEX "threads_vendor_uq" ON "threads" USING btree ("event_id","vendor_id") WHERE kind = 'vendor';--> statement-breakpoint
CREATE UNIQUE INDEX "threads_fn_uq" ON "threads" USING btree ("event_id","function_id") WHERE kind = 'function';--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_contacts_open_uq" ON "vendor_contacts" USING btree ("vendor_id","identifier_type","identifier_value") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "vendor_contacts_user_idx" ON "vendor_contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vendor_contacts_identifier_idx" ON "vendor_contacts" USING btree ("identifier_type","identifier_value");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sheet_items" ADD CONSTRAINT "run_sheet_items_owner_vendor_id_vendors_id_fk" FOREIGN KEY ("owner_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;