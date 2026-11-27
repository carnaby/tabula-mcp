CREATE TYPE "public"."document_source" AS ENUM('fornax', 'file');--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'parse';--> statement-breakpoint
CREATE TABLE "report_documents" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"source" "document_source" NOT NULL,
	"model" text,
	"pages" integer,
	"tables" integer,
	"characters" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('tabula'::regconfig, left("text", 100000))) STORED,
	CONSTRAINT "report_documents_text_len" CHECK (char_length("report_documents"."text") <= 1000000),
	CONSTRAINT "report_documents_counts" CHECK ("report_documents"."characters" >= 0 AND ("report_documents"."pages" IS NULL OR "report_documents"."pages" >= 0) AND ("report_documents"."tables" IS NULL OR "report_documents"."tables" >= 0))
);
--> statement-breakpoint
ALTER TABLE "report_documents" ADD CONSTRAINT "report_documents_attachment_id_report_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."report_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_documents_search_idx" ON "report_documents" USING gin ("search");