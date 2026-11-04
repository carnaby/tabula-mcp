-- Recordings uploaded before the transcription worker existed: queue those of open reports that are still on disk.
-- A video without a sound track is completed by the worker with an empty transcript.
INSERT INTO "report_jobs" ("attachment_id", "kind")
SELECT a."id", 'transcribe'
FROM "report_attachments" a
JOIN "reports" r ON r."id" = a."report_id"
WHERE a."kind" IN ('video', 'audio') AND a."purged_at" IS NULL AND r."status" <> 'done'
ON CONFLICT DO NOTHING;
