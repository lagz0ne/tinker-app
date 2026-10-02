CREATE FUNCTION start_sync_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('start_sync', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sync_event_committed AFTER INSERT ON sync_event
FOR EACH STATEMENT EXECUTE FUNCTION start_sync_wake();
--> statement-breakpoint
CREATE TRIGGER sync_session_changed AFTER INSERT OR UPDATE OR DELETE ON session
FOR EACH STATEMENT EXECUTE FUNCTION start_sync_wake();
