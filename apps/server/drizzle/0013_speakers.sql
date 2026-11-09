ALTER TABLE "report_transcripts" ADD COLUMN "diarization" jsonb;--> statement-breakpoint
ALTER TABLE "report_transcripts" ADD COLUMN "speakers" jsonb DEFAULT '{}'::jsonb NOT NULL;