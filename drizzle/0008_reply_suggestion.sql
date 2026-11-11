CREATE TABLE "reply_suggestion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"based_on_message_id" uuid,
	"data" jsonb NOT NULL,
	"article_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"mode" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_suggestion_mode_chk" CHECK ("reply_suggestion"."mode" in ('demo', 'live')),
	CONSTRAINT "reply_suggestion_articles_chk" CHECK (cardinality("reply_suggestion"."article_ids") <= 3)
);
--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_based_on_message_id_ticket_message_id_fk" FOREIGN KEY ("based_on_message_id") REFERENCES "public"."ticket_message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_suggestion" ADD CONSTRAINT "reply_suggestion_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reply_suggestion_ticket_idx" ON "reply_suggestion" USING btree ("ticket_id","created_at");