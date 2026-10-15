ALTER TABLE "issue" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- Backfill the former numeric ranks as valid base-62 fractional integer keys.
UPDATE issue SET rank = 'f' || (
  SELECT string_agg(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    ((issue.number::bigint / power(62::numeric, place)::bigint) % 62)::int + 1, 1), '' ORDER BY place DESC)
  FROM generate_series(0, 5) AS place
);
