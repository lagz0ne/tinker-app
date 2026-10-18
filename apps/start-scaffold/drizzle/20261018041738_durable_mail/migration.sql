CREATE TABLE "mail_outbox" (
	"id" bigserial PRIMARY KEY,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"dedupe_key" text NOT NULL UNIQUE,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"dead_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "mail_outbox_due" ON "mail_outbox" ("next_at","id") WHERE "sent_at" is null and "attempts" < 12;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_board_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM added) THEN PERFORM pg_notify('board_outbox', ''); END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER board_outbox_insert AFTER INSERT ON mail_outbox
REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION notify_board_outbox();
