DROP INDEX "mail_outbox_due";--> statement-breakpoint
CREATE INDEX "mail_outbox_due" ON "mail_outbox" ("next_at","id") WHERE "sent_at" is null and "attempts" < 12;--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_board_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM added) THEN
    PERFORM pg_notify('board_outbox', '');
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER board_outbox_insert ON mail_outbox;
--> statement-breakpoint
CREATE TRIGGER board_outbox_insert AFTER INSERT ON mail_outbox
REFERENCING NEW TABLE AS added
FOR EACH STATEMENT EXECUTE FUNCTION notify_board_outbox();
