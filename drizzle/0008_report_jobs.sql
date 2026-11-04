CREATE TYPE "public"."job_kind" AS ENUM('transcribe');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "report_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"kind" "job_kind" DEFAULT 'transcribe' NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"worker" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_transcripts" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"language" text,
	"model" text NOT NULL,
	"text" text NOT NULL,
	"segments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, left("text", 100000))) STORED
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"name" text PRIMARY KEY NOT NULL,
	"version" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_attachment_id_report_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."report_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_transcripts" ADD CONSTRAINT "report_transcripts_attachment_id_report_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."report_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_jobs_attachment_kind_idx" ON "report_jobs" USING btree ("attachment_id","kind");--> statement-breakpoint
CREATE INDEX "report_jobs_queue_idx" ON "report_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "report_transcripts_search_idx" ON "report_transcripts" USING gin ("search");