-- Transcription moves to Fornax. The old worker's leases mean nothing now: running jobs go back to the queue and every
-- waiting job is submitted to Fornax from the start (its attempts counted the old worker's tries, not submits).
UPDATE "report_jobs" SET
  "status" = 'queued',
  "attempts" = 0,
  "run_after" = CASE WHEN "status" = 'running' THEN now() ELSE "run_after" END,
  "error" = NULL,
  "started_at" = NULL,
  "updated_at" = now()
WHERE "status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN "fornax_job_id" text;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN "fornax_change" text;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN "submitting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN "progress" integer;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN "progress_message" text;--> statement-breakpoint
ALTER TABLE "report_jobs" DROP COLUMN "lease_id";--> statement-breakpoint
ALTER TABLE "report_jobs" DROP COLUMN "lease_until";--> statement-breakpoint
ALTER TABLE "report_jobs" DROP COLUMN "worker";--> statement-breakpoint
DROP TABLE "workers";
