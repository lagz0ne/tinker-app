-- Public history exists before any page can read it.
INSERT INTO "sync_stream" ("id") VALUES ('public') ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Existing accounts predate the awaited account-create hook.
INSERT INTO "sync_stream" ("id") SELECT "id" FROM "user" ON CONFLICT DO NOTHING;
