CREATE TYPE "public"."idempotency_state" AS ENUM('pending', 'done');--> statement-breakpoint
CREATE TABLE "app_idempotency" (
	"connection_id" uuid NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" "idempotency_state" NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_idempotency_connection_id_key_pk" PRIMARY KEY("connection_id","key"),
	CONSTRAINT "app_idempotency_done" CHECK (("app_idempotency"."state" = 'done') = ("app_idempotency"."response_status" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "app_idempotency" ADD CONSTRAINT "app_idempotency_connection_id_oauth_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."oauth_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_idempotency_created_idx" ON "app_idempotency" USING btree ("created_at");