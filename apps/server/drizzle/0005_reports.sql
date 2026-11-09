CREATE TYPE "public"."attachment_kind" AS ENUM('image', 'video', 'audio', 'frame');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('new', 'triaged', 'done');--> statement-breakpoint
CREATE TABLE "report_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"kind" "attachment_kind" NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"duration_ms" integer,
	"source_id" uuid,
	"at_ms" integer,
	"created_by" text NOT NULL,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"triage" text DEFAULT '' NOT NULL,
	"status" "report_status" DEFAULT 'new' NOT NULL,
	"source" "memory_source" NOT NULL,
	"edited_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce(body, '') || ' ' || coalesce(triage, '')), 'C')) STORED,
	CONSTRAINT "reports_title_len" CHECK (char_length("reports"."title") between 1 and 200),
	CONSTRAINT "reports_body_len" CHECK (char_length("reports"."body") <= 20000),
	CONSTRAINT "reports_triage_len" CHECK (char_length("reports"."triage") <= 50000)
);
--> statement-breakpoint
ALTER TABLE "report_attachments" ADD CONSTRAINT "report_attachments_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_attachments" ADD CONSTRAINT "report_attachments_source_id_report_attachments_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."report_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_attachments_report_idx" ON "report_attachments" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_attachments_storage_key_idx" ON "report_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "reports_search_idx" ON "reports" USING gin ("search");--> statement-breakpoint
CREATE INDEX "reports_project_status_idx" ON "reports" USING btree ("project_id","status");