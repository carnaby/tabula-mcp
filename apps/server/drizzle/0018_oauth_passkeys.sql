CREATE TYPE "public"."oauth_resource" AS ENUM('mcp', 'api');--> statement-breakpoint
CREATE TYPE "public"."passkey_registration_kind" AS ENUM('link', 'add');--> statement-breakpoint
CREATE TYPE "public"."webauthn_purpose" AS ENUM('login', 'register');--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"hash" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"resource" "oauth_resource" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_name" text,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"hash" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" "oauth_resource" NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"resource" "oauth_resource" NOT NULL,
	"scope" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_pending" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" "oauth_resource" NOT NULL,
	"scope" text NOT NULL,
	"state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"hash" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "passkey_registration_kind" NOT NULL,
	"token_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "passkeys_name_len" CHECK (char_length("passkeys"."name") between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "ui_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_sha256" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"challenge_sha256" text PRIMARY KEY NOT NULL,
	"purpose" "webauthn_purpose" NOT NULL,
	"registration_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "agent_model" text;--> statement-breakpoint
ALTER TABLE "message_events" ADD COLUMN "actor_model" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "created_by_model" text;--> statement-breakpoint
ALTER TABLE "project_file_revisions" ADD COLUMN "updated_by_model" text;--> statement-breakpoint
ALTER TABLE "project_files" ADD COLUMN "updated_by_model" text;--> statement-breakpoint
ALTER TABLE "report_attachments" ADD COLUMN "created_by_model" text;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "edited_by_model" text;--> statement-breakpoint
ALTER TABLE "thought_revisions" ADD COLUMN "edited_by_model" text;--> statement-breakpoint
ALTER TABLE "thoughts" ADD COLUMN "edited_by_model" text;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_pending" ADD CONSTRAINT "oauth_pending_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_registration_id_passkey_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."passkey_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_connection_idx" ON "oauth_access_tokens" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_live_name_idx" ON "oauth_connections" USING btree ("name") WHERE "oauth_connections"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "oauth_connections_client_idx" ON "oauth_connections" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_connection_idx" ON "oauth_refresh_tokens" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "passkey_registrations_sha256_idx" ON "passkey_registrations" USING btree ("token_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential_idx" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ui_sessions_sha256_idx" ON "ui_sessions" USING btree ("token_sha256");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION messages_protect_sent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.to_project IS DISTINCT FROM OLD.to_project
    OR NEW.from_project IS DISTINCT FROM OLD.from_project
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
