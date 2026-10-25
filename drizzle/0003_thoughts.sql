CREATE TABLE "thought_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thought_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thoughts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"source" "memory_source" NOT NULL,
	"edited_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('simple'::regconfig, tabula_tags_text(tags)), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(body, '')), 'C')) STORED,
	CONSTRAINT "thoughts_title_len" CHECK (char_length("thoughts"."title") between 1 and 200),
	CONSTRAINT "thoughts_body_len" CHECK (char_length("thoughts"."body") <= 50000)
);
--> statement-breakpoint
ALTER TABLE "thought_revisions" ADD CONSTRAINT "thought_revisions_thought_id_thoughts_id_fk" FOREIGN KEY ("thought_id") REFERENCES "public"."thoughts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thought_revisions_thought_idx" ON "thought_revisions" USING btree ("thought_id","version");--> statement-breakpoint
CREATE INDEX "thoughts_search_idx" ON "thoughts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "thoughts_updated_idx" ON "thoughts" USING btree ("archived","updated_at");