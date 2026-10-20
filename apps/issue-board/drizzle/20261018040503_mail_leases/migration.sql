ALTER TABLE "mail_outbox" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "dead_at" timestamp with time zone;