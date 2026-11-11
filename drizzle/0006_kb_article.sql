CREATE TABLE "kb_article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"author_id" text,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body), 'B')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_article_status_chk" CHECK ("kb_article"."status" in ('draft', 'published')),
	CONSTRAINT "kb_article_slug_chk" CHECK ("kb_article"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("kb_article"."slug") <= 100),
	CONSTRAINT "kb_article_title_chk" CHECK (char_length("kb_article"."title") between 1 and 150),
	CONSTRAINT "kb_article_body_chk" CHECK (char_length("kb_article"."body") between 1 and 10000)
);
--> statement-breakpoint
ALTER TABLE "kb_article" ADD CONSTRAINT "kb_article_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_article_slug_uidx" ON "kb_article" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "kb_article_search_idx" ON "kb_article" USING gin ("search");--> statement-breakpoint
CREATE INDEX "kb_article_status_updated_idx" ON "kb_article" USING btree ("status","updated_at");