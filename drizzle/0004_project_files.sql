CREATE TABLE "project_file_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"is_state" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, translate(coalesce(path, ''), '/._-', '    ')), 'A') || setweight(to_tsvector('simple'::regconfig, left(coalesce(content, ''), 100000)), 'C')) STORED,
	CONSTRAINT "project_files_path_len" CHECK (char_length("project_files"."path") between 1 and 512),
	CONSTRAINT "project_files_size" CHECK ("project_files"."size" between 0 and 1048576)
);
--> statement-breakpoint
ALTER TABLE "notes" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD CONSTRAINT "project_file_revisions_file_id_project_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."project_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_file_revisions_file_idx" ON "project_file_revisions" USING btree ("file_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_files_project_path_idx" ON "project_files" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "project_files_search_idx" ON "project_files" USING gin ("search");