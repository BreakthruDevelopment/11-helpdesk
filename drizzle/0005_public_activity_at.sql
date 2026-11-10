DROP INDEX "ticket_customer_updated_idx";--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "public_activity_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "ticket_customer_updated_idx" ON "ticket" USING btree ("customer_id","public_activity_at");--> statement-breakpoint
UPDATE "ticket" SET "public_activity_at" = "updated_at";
