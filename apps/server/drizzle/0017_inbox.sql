CREATE TYPE "public"."message_status" AS ENUM('new', 'in_progress', 'waiting', 'done', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('request', 'report');--> statement-breakpoint
CREATE TYPE "public"."message_waiting_on" AS ENUM('author', 'sender');--> statement-breakpoint
CREATE TABLE "message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" "memory_source" NOT NULL,
	"actor" text NOT NULL,
	"version" integer NOT NULL,
	"from_status" "message_status",
	"to_status" "message_status",
	"waiting_on" "message_waiting_on",
	"reply" text,
	CONSTRAINT "message_events_reply_len" CHECK (char_length("message_events"."reply") <= 20000)
);
--> statement-breakpoint
CREATE TABLE "message_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"token_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_project" text NOT NULL,
	"from_project" text NOT NULL,
	"type" "message_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"related_to" uuid,
	"status" "message_status" DEFAULT 'new' NOT NULL,
	"waiting_on" "message_waiting_on",
	"version" integer DEFAULT 1 NOT NULL,
	"source" "memory_source" NOT NULL,
	"created_by" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_title_len" CHECK (char_length("messages"."title") between 1 and 200),
	CONSTRAINT "messages_body_len" CHECK (char_length("messages"."body") between 1 and 50000),
	CONSTRAINT "messages_waiting_on" CHECK (("messages"."status" = 'waiting') = ("messages"."waiting_on" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_tokens" ADD CONSTRAINT "message_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_to_project_projects_id_fk" FOREIGN KEY ("to_project") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_project_projects_id_fk" FOREIGN KEY ("from_project") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_related_to_messages_id_fk" FOREIGN KEY ("related_to") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_events_version_idx" ON "message_events" USING btree ("message_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "message_tokens_sha256_idx" ON "message_tokens" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "messages_to_status_idx" ON "messages" USING btree ("to_project","status");--> statement-breakpoint
CREATE INDEX "messages_from_status_idx" ON "messages" USING btree ("from_project","status");--> statement-breakpoint
CREATE INDEX "messages_updated_idx" ON "messages" USING btree ("updated_at");
--> statement-breakpoint
CREATE FUNCTION messages_protect_sent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.to_project IS DISTINCT FROM OLD.to_project
    OR NEW.from_project IS DISTINCT FROM OLD.from_project
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.related_to IS DISTINCT FROM OLD.related_to AND NEW.related_to IS NOT NULL)
  THEN
    RAISE EXCEPTION 'a sent message cannot be changed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_protect_sent BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION messages_protect_sent();
--> statement-breakpoint
CREATE FUNCTION message_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'message history cannot be changed';
END $$;
--> statement-breakpoint
CREATE TRIGGER message_events_append_only BEFORE UPDATE ON message_events FOR EACH ROW EXECUTE FUNCTION message_events_append_only();
--> statement-breakpoint
CREATE FUNCTION message_events_no_direct_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Depth 1 is a DELETE on this table itself; the cascade from messages runs one level deeper.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'message history cannot be changed';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER message_events_no_direct_delete BEFORE DELETE ON message_events FOR EACH ROW EXECUTE FUNCTION message_events_no_direct_delete();
