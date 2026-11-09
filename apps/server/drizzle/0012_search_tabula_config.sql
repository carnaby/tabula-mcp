-- The search columns move from the "simple" to the "tabula" configuration (0011). Dropping a column drops its GIN index,
-- so each index is created again (drizzle-kit does not emit that); SET EXPRESSION would need Postgres 17.
ALTER TABLE "memories" drop column "search";--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('tabula'::regconfig, coalesce(body, '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "memories_search_idx" ON "memories" USING gin ("search");--> statement-breakpoint
ALTER TABLE "notes" drop column "search";--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('tabula'::regconfig, coalesce(summary, '') || ' ' || coalesce(body, '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "notes_search_idx" ON "notes" USING gin ("search");--> statement-breakpoint
ALTER TABLE "project_files" drop column "search";--> statement-breakpoint
ALTER TABLE "project_files" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('tabula'::regconfig, translate(coalesce(path, ''), '/._-', '    ')), 'A') || setweight(to_tsvector('tabula'::regconfig, left(coalesce(content, ''), 100000)), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "project_files_search_idx" ON "project_files" USING gin ("search");--> statement-breakpoint
ALTER TABLE "report_transcripts" drop column "search";--> statement-breakpoint
ALTER TABLE "report_transcripts" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (to_tsvector('tabula'::regconfig, left("text", 100000))) STORED;--> statement-breakpoint
CREATE INDEX "report_transcripts_search_idx" ON "report_transcripts" USING gin ("search");--> statement-breakpoint
ALTER TABLE "reports" drop column "search";--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, coalesce(body, '') || ' ' || coalesce(triage, '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "reports_search_idx" ON "reports" USING gin ("search");--> statement-breakpoint
ALTER TABLE "thoughts" drop column "search";--> statement-breakpoint
ALTER TABLE "thoughts" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('tabula'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('tabula'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('tabula'::regconfig, coalesce(body, '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "thoughts_search_idx" ON "thoughts" USING gin ("search");
