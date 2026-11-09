CREATE TYPE "public"."memory_kind" AS ENUM('rule', 'decision', 'fact', 'gotcha');--> statement-breakpoint
CREATE TYPE "public"."memory_source" AS ENUM('agent', 'human');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'deprecated');--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"kind" "memory_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"supersedes_id" uuid,
	"deprecated_reason" text,
	"source" "memory_source" NOT NULL,
	"agent_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('simple'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(body, '')), 'C')) STORED,
	CONSTRAINT "memories_title_len" CHECK (char_length("memories"."title") between 1 and 120),
	CONSTRAINT "memories_body_len" CHECK (char_length("memories"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('simple'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(summary, '') || ' ' || coalesce(body, '')), 'C')) STORED,
	CONSTRAINT "notes_summary_len" CHECK (char_length("notes"."summary") <= 200)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_id_memories_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_search_idx" ON "memories" USING gin ("search");--> statement-breakpoint
CREATE INDEX "memories_project_status_idx" ON "memories" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search");--> statement-breakpoint
CREATE INDEX "notes_project_idx" ON "notes" USING btree ("project_id");