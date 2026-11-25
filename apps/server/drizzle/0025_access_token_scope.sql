ALTER TABLE "oauth_access_tokens" ADD COLUMN "scope" text;--> statement-breakpoint
UPDATE "oauth_access_tokens" AS t SET "scope" = c."scope" FROM "oauth_connections" AS c WHERE c."id" = t."connection_id";--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ALTER COLUMN "scope" SET NOT NULL;