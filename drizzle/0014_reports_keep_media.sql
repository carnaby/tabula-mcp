ALTER TABLE "reports" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "keep_media" boolean DEFAULT false NOT NULL;