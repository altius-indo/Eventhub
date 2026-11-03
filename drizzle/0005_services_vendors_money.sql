CREATE TYPE "public"."approval_state" AS ENUM('proposed', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending_approval', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."catalogue_kind" AS ENUM('service', 'standalone');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('contract', 'quote', 'invoice', 'receipt', 'brief', 'other');--> statement-breakpoint
CREATE TYPE "public"."milestone_kind" AS ENUM('advance', 'milestone', 'final');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('upi', 'bank', 'cheque', 'cash', 'card');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('recorded', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."quote_line_scope" AS ENUM('requirement', 'service', 'package');--> statement-breakpoint
CREATE TYPE "public"."requirement_lifecycle" AS ENUM('open', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."requirement_priority" AS ENUM('must', 'nice');--> statement-breakpoint
CREATE TYPE "public"."tax_type" AS ENUM('none', 'cgst_sgst', 'igst');--> statement-breakpoint
CREATE TABLE "booking_key_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"label" text NOT NULL,
	"date" date NOT NULL,
	"task_id" uuid
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"quote_id" uuid,
	"status" "booking_status" DEFAULT 'pending_approval' NOT NULL,
	"subtotal_paise" bigint DEFAULT 0 NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	"cancellation_policy" text,
	"deliverables" text,
	"notes" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "bookings_event_uq" UNIQUE("id","event_id")
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"function_id" uuid,
	"title" text NOT NULL,
	"estimate_paise" bigint DEFAULT 0 NOT NULL,
	"payer" jsonb,
	"notes" text,
	"approval_state" "approval_state" DEFAULT 'approved' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_blobs" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"data" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "document_kind" DEFAULT 'other' NOT NULL,
	"vendor_id" uuid,
	"quote_id" uuid,
	"booking_id" uuid,
	"invoice_id" uuid,
	"payment_id" uuid,
	"service_id" uuid,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfilments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"requirement_id" uuid,
	"quote_line_id" uuid,
	"quantity" integer,
	"amount_paise" bigint NOT NULL,
	"gst_paise" bigint DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"service_id" uuid,
	"description" text NOT NULL,
	"hsn_sac" text,
	"amount_paise" bigint NOT NULL,
	"gst_rate_bps" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"booking_id" uuid,
	"number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"supplier_gstin" text,
	"tax_type" "tax_type" DEFAULT 'none' NOT NULL,
	"subtotal_paise" bigint NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_uq" UNIQUE("event_id","vendor_id","number")
);
--> statement-breakpoint
CREATE TABLE "payment_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "milestone_kind" DEFAULT 'milestone' NOT NULL,
	"label" text,
	"amount_paise" bigint NOT NULL,
	"due_date" date,
	"payer" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"last_reminded_on" date
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_id" uuid,
	"budget_line_id" uuid,
	"invoice_id" uuid,
	"paid_on" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"reference" text,
	"payer" jsonb,
	"notes" text,
	"state" "payment_state" DEFAULT 'recorded' NOT NULL,
	"recorded_by" uuid,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount_paise" > 0),
	CONSTRAINT "payments_target_ck" CHECK (("payments"."booking_id" is null) <> ("payments"."budget_line_id" is null))
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"scope" "quote_line_scope" NOT NULL,
	"service_id" uuid,
	"requirement_id" uuid,
	"description" text,
	"quantity" integer,
	"amount_paise" bigint NOT NULL,
	"gst_rate_bps" integer DEFAULT 0 NOT NULL,
	"conditional" boolean DEFAULT false NOT NULL,
	"allocation" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quote_lines_scope_ck" CHECK (("quote_lines"."scope" = 'requirement' and "quote_lines"."requirement_id" is not null and "quote_lines"."service_id" is not null) or ("quote_lines"."scope" = 'service' and "quote_lines"."requirement_id" is null and "quote_lines"."service_id" is not null) or ("quote_lines"."scope" = 'package' and "quote_lines"."requirement_id" is null and "quote_lines"."service_id" is null))
);
--> statement-breakpoint
CREATE TABLE "quote_request_services" (
	"request_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "quote_request_services_request_id_service_id_pk" PRIMARY KEY("request_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "quote_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"due_date" date,
	"message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"request_id" uuid,
	"root_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"vendor_ref" text,
	"received_on" date,
	"valid_until" date,
	"terms" text,
	"tax_type" "tax_type" DEFAULT 'none' NOT NULL,
	"all_or_nothing" boolean DEFAULT false NOT NULL,
	"min_functions" integer,
	"declined_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_root_version_uq" UNIQUE("root_id","version"),
	CONSTRAINT "quotes_event_uq" UNIQUE("id","event_id")
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"title" text NOT NULL,
	"quantity" integer,
	"unit" text,
	"specs" text,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"venue" text,
	"estimate_paise" bigint,
	"priority" "requirement_priority" DEFAULT 'must' NOT NULL,
	"payer" jsonb,
	"approval_state" "approval_state" DEFAULT 'approved' NOT NULL,
	"lifecycle" "requirement_lifecycle" DEFAULT 'open' NOT NULL,
	"delivered_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirements_event_uq" UNIQUE("id","event_id"),
	CONSTRAINT "requirements_service_uq" UNIQUE("id","service_id")
);
--> statement-breakpoint
CREATE TABLE "service_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"system_key" text,
	"name" text NOT NULL,
	"kind" "catalogue_kind" DEFAULT 'service' NOT NULL,
	"requirement_templates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_approve_below_paise" bigint DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_types_key_uq" UNIQUE("event_id","system_key"),
	CONSTRAINT "service_types_event_uq" UNIQUE("id","event_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"function_id" uuid NOT NULL,
	"service_type_id" uuid NOT NULL,
	"name" text,
	"owner_user_id" uuid,
	"brief" text,
	"payer" jsonb,
	"approval_state" "approval_state" DEFAULT 'approved' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_event_uq" UNIQUE("id","event_id")
);
--> statement-breakpoint
CREATE TABLE "vendor_service_types" (
	"vendor_id" uuid NOT NULL,
	"service_type_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "vendor_service_types_vendor_id_service_type_id_pk" PRIMARY KEY("vendor_id","service_type_id")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"gstin" text,
	"pan_enc" text,
	"pan_last4" text,
	"bank_enc" text,
	"bank_last4" text,
	"rating" integer,
	"rating_note" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_event_uq" UNIQUE("id","event_id")
);
--> statement-breakpoint
ALTER TABLE "booking_key_dates" ADD CONSTRAINT "booking_key_dates_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_key_dates" ADD CONSTRAINT "booking_key_dates_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_key_dates" ADD CONSTRAINT "booking_key_dates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_vendor_fk" FOREIGN KEY ("vendor_id","event_id") REFERENCES "public"."vendors"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_cat_fk" FOREIGN KEY ("category_id","event_id") REFERENCES "public"."service_types"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_blobs" ADD CONSTRAINT "document_blobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_quote_line_id_quote_lines_id_fk" FOREIGN KEY ("quote_line_id") REFERENCES "public"."quote_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_fk" FOREIGN KEY ("vendor_id","event_id") REFERENCES "public"."vendors"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_milestones" ADD CONSTRAINT "payment_milestones_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_budget_line_id_budget_lines_id_fk" FOREIGN KEY ("budget_line_id") REFERENCES "public"."budget_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_req_fk" FOREIGN KEY ("requirement_id","service_id") REFERENCES "public"."requirements"("id","service_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_request_services" ADD CONSTRAINT "quote_request_services_request_id_quote_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."quote_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_request_services" ADD CONSTRAINT "quote_request_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_request_services" ADD CONSTRAINT "quote_request_services_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_vendor_fk" FOREIGN KEY ("vendor_id","event_id") REFERENCES "public"."vendors"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_request_id_quote_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."quote_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_vendor_fk" FOREIGN KEY ("vendor_id","event_id") REFERENCES "public"."vendors"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_service_fk" FOREIGN KEY ("service_id","event_id") REFERENCES "public"."services"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_types" ADD CONSTRAINT "service_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_fn_fk" FOREIGN KEY ("function_id","event_id") REFERENCES "public"."functions"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_type_fk" FOREIGN KEY ("service_type_id","event_id") REFERENCES "public"."service_types"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_service_types" ADD CONSTRAINT "vendor_service_types_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_service_types" ADD CONSTRAINT "vendor_service_types_service_type_id_service_types_id_fk" FOREIGN KEY ("service_type_id") REFERENCES "public"."service_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_service_types" ADD CONSTRAINT "vendor_service_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_key_dates_booking_idx" ON "booking_key_dates" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "bookings_event_idx" ON "bookings" USING btree ("event_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_live_quote_uq" ON "bookings" USING btree ("quote_id") WHERE status <> 'cancelled' and quote_id is not null;--> statement-breakpoint
CREATE INDEX "budget_lines_event_idx" ON "budget_lines" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "documents_event_idx" ON "documents" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "fulfilments_booking_idx" ON "fulfilments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "fulfilments_req_idx" ON "fulfilments" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "fulfilments_service_idx" ON "fulfilments" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_milestones_booking_idx" ON "payment_milestones" USING btree ("booking_id","sort_order");--> statement-breakpoint
CREATE INDEX "payments_booking_idx" ON "payments" USING btree ("booking_id","state");--> statement-breakpoint
CREATE INDEX "payments_event_idx" ON "payments" USING btree ("event_id","paid_on");--> statement-breakpoint
CREATE INDEX "quote_lines_quote_idx" ON "quote_lines" USING btree ("quote_id","sort_order");--> statement-breakpoint
CREATE INDEX "quote_lines_service_idx" ON "quote_lines" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "quote_request_services_service_idx" ON "quote_request_services" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "quote_requests_event_idx" ON "quote_requests" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "quotes_event_idx" ON "quotes" USING btree ("event_id","vendor_id");--> statement-breakpoint
CREATE INDEX "requirements_service_idx" ON "requirements" USING btree ("service_id","sort_order");--> statement-breakpoint
CREATE INDEX "services_fn_idx" ON "services" USING btree ("function_id");--> statement-breakpoint
CREATE INDEX "vendors_event_idx" ON "vendors" USING btree ("event_id","name");