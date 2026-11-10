CREATE TABLE "mail_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" text NOT NULL,
	"ticket_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_message_kind_chk" CHECK ("mail_message"."kind" in ('ticket_created', 'agent_reply', 'ticket_resolved', 'ticket_assigned', 'customer_reply')),
	CONSTRAINT "mail_message_subject_chk" CHECK (char_length("mail_message"."subject") <= 150),
	CONSTRAINT "mail_message_snippet_chk" CHECK (char_length("mail_message"."snippet") <= 200)
);
--> statement-breakpoint
CREATE TABLE "ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"customer_id" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"assignee_id" text,
	"triage" jsonb,
	"triage_source" text DEFAULT 'none' NOT NULL,
	"first_response_due_at" timestamp with time zone NOT NULL,
	"resolution_due_at" timestamp with time zone NOT NULL,
	"first_responded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_seconds" integer DEFAULT 0 NOT NULL,
	"breached_first_response_at" timestamp with time zone,
	"breached_resolution_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_id_customer_uq" UNIQUE("id","customer_id"),
	CONSTRAINT "ticket_status_chk" CHECK ("ticket"."status" in ('new', 'open', 'pending_customer', 'resolved')),
	CONSTRAINT "ticket_priority_chk" CHECK ("ticket"."priority" in ('urgent', 'high', 'normal', 'low')),
	CONSTRAINT "ticket_category_chk" CHECK ("ticket"."category" in ('billing', 'technical', 'account', 'how_to', 'bug', 'feature_request', 'other')),
	CONSTRAINT "ticket_triage_source_chk" CHECK ("ticket"."triage_source" in ('ai', 'agent', 'none')),
	CONSTRAINT "ticket_subject_chk" CHECK (char_length("ticket"."subject") between 1 and 150),
	CONSTRAINT "ticket_paused_chk" CHECK ("ticket"."paused_seconds" >= 0 and ("ticket"."paused_at" is null or "ticket"."status" = 'pending_customer'))
);
--> statement-breakpoint
CREATE TABLE "ticket_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"author_id" text,
	"author_role" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"body" text NOT NULL,
	"ai_assisted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_message_visibility_chk" CHECK ("ticket_message"."visibility" in ('public', 'internal')),
	CONSTRAINT "ticket_message_author_role_chk" CHECK ("ticket_message"."author_role" in ('customer', 'agent')),
	CONSTRAINT "ticket_message_internal_agent_chk" CHECK ("ticket_message"."visibility" = 'public' or "ticket_message"."author_role" = 'agent'),
	CONSTRAINT "ticket_message_body_chk" CHECK (char_length("ticket_message"."body") between 1 and 5000)
);
--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_message" ADD CONSTRAINT "mail_message_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_customer_id_user_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_message" ADD CONSTRAINT "ticket_message_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_message" ADD CONSTRAINT "ticket_message_ticket_customer_fk" FOREIGN KEY ("ticket_id","customer_id") REFERENCES "public"."ticket"("id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_message_recipient_idx" ON "mail_message" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_message_ticket_idx" ON "mail_message" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_number_uidx" ON "ticket" USING btree ("number");--> statement-breakpoint
CREATE INDEX "ticket_status_due_idx" ON "ticket" USING btree ("status","resolution_due_at");--> statement-breakpoint
CREATE INDEX "ticket_customer_updated_idx" ON "ticket" USING btree ("customer_id","updated_at");--> statement-breakpoint
CREATE INDEX "ticket_assignee_idx" ON "ticket" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "ticket_message_thread_idx" ON "ticket_message" USING btree ("ticket_id","created_at");--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'ai', 'upload', 'ticket', 'ticket_day', 'message', 'kb_write', 'retriage', 'suggest', 'demo_load'));