-- "external" marks messages from agents that work outside any project; no project may have that slug.
-- Stops the upgrade with a clear message instead of a bare CHECK violation below.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE id = 'external') THEN
    RAISE EXCEPTION 'the project slug "external" is reserved for messages from agents outside any project, but a project "external" exists: move its content to another project and delete it, then upgrade';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_sender";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_id_not_reserved";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_len" CHECK ("messages"."sender" IS NULL OR char_length("messages"."sender") BETWEEN 1 AND 80);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender" CHECK (("messages"."from_project" IS NOT NULL AND "messages"."sender" IS NULL)
        OR ("messages"."from_project" IS NULL AND "messages"."source" = 'human' AND "messages"."sender" IS NULL)
        OR ("messages"."from_project" IS NULL AND "messages"."source" = 'agent' AND "messages"."sender" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_not_reserved" CHECK ("projects"."id" NOT IN ('author', 'external'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION messages_protect_sent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.to_project IS DISTINCT FROM OLD.to_project
    OR NEW.from_project IS DISTINCT FROM OLD.from_project
    OR NEW.sender IS DISTINCT FROM OLD.sender
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_by_model IS DISTINCT FROM OLD.created_by_model
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.related_to IS DISTINCT FROM OLD.related_to AND NEW.related_to IS NOT NULL)
  THEN
    RAISE EXCEPTION 'a sent message cannot be changed';
  END IF;
  RETURN NEW;
END $$;
