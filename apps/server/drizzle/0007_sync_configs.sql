CREATE TABLE "project_sync_configs" (
	"project_id" text PRIMARY KEY NOT NULL,
	"sync" text[] NOT NULL,
	"state" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_sync_configs" ADD CONSTRAINT "project_sync_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;