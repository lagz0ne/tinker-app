CREATE TABLE "mail_outbox" (
	"id" bigserial PRIMARY KEY,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"dedupe_key" text NOT NULL UNIQUE,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "mail_outbox_due" ON "mail_outbox" ("next_at","id") WHERE "sent_at" is null;--> statement-breakpoint
ALTER TABLE "comment" DROP CONSTRAINT "comment_body", ADD CONSTRAINT "comment_body" CHECK (char_length("body") between 1 and 5000 and "body" = btrim("body", U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'));--> statement-breakpoint
CREATE FUNCTION notify_board_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('board_outbox', '');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER board_outbox_insert AFTER INSERT ON mail_outbox
FOR EACH STATEMENT EXECUTE FUNCTION notify_board_outbox();
