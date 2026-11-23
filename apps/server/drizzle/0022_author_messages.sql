ALTER TABLE "messages" ALTER COLUMN "from_project" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender" CHECK ("messages"."from_project" IS NOT NULL OR "messages"."source" = 'human');--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_id_not_reserved" CHECK ("projects"."id" <> 'author');