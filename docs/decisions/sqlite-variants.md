# SQLite as a second database

Date: 2026-10-28. Status: accepted.
Asked by: Hedl on Tinker, gap G0.
Duke, 2026-10-26: "SQLite is just fine".
Duke, 2026-10-26: no workarounds in Hedl;
a Tinker gap is fixed in Tinker.
Duke, 2026-10-28: use Reylo
"so we no longer need drizzle".
Duke, 2026-10-28: "Accept ts 7.1 beta".

## Context

Hedl moves onto tinker-app.
Hedl keeps SQLite.
Four components are Postgres only today:

- `database`: `pg` pool, `LISTEN`,
  advisory lock for migrations.
- `auth`: `pgTable` schema,
  Better Auth `provider: "pg"`.
- `sync`: `pgTable` and `jsonb`,
  `pg_notify`, a trigger, `LISTEN`.
- `mail`: `pgTable` outbox, `LISTEN`.

In auth and sync, about 100 of 900 lines
are Postgres only.
Drizzle types Postgres and SQLite tables apart.
One shared query cannot serve both
without casts.

## Precedent

Rails 8 runs SQLite in production.
Its defaults are the settled trade-offs:

- WAL journal.
- `synchronous = NORMAL`.
- `busy_timeout` on every connection.
- Writes use `BEGIN IMMEDIATE`.
- One writer at a time.

Solid Cable replaces `LISTEN` with polling:
writers insert a row, readers poll for new
rows past the last id they saw.

shadcn ships a style as a whole copy
of a component, not as a switch inside it.

sqlc (Go) and PgTyped type plain `.sql`
files against a real schema.
Reylo does the same inside TypeScript 7.1:
`import getUser from "./get_user.sql"`.

dbmate and golang-migrate run plain,
numbered `.sql` migration files and keep
a table of the ones applied.

## Drizzle goes

Reylo replaces each Drizzle job:

- Queries: one `.sql` file each,
  typed by Reylo, run with `.runSync()`.
- Schema: the migration files are the schema.
  No `pgTable` or `sqliteTable`.
- `drizzle-kit generate`: gone.
  A person writes the next `.sql` migration.
- Drizzle migrator: `migrate` runs the
  numbered files, as dbmate does.
- Better Auth: takes the `DatabaseSync`
  itself (its Kysely `node:sqlite` dialect).
  No drizzle adapter.

What it costs:

- TypeScript 7.1 beta, with
  `--runExternalCode` on the type check.
- Node 24 or later (CI has 24).
- The type check needs a dev database.
  For SQLite that is a file: CI applies the
  migrations to it, then type checks.
- Reylo is 0.6.0 and one day old.
- Reylo's Vite plugin goes in
  `vite.config.ts`, for the build and Vitest.
- `.sql` files stay in server code only.

## Decision

Variant components, each a whole copy:

- `database-sqlite`
- `auth-sqlite`
- `sync-sqlite`

An app picks one set.
`mail` gets no SQLite variant until an app
asks for one (Hedl sends no mail).

### database-sqlite

Same public names as `database`:
`database`, `databaseSetup`, `migrate`,
`transaction`, `databaseUrl`.

- Driver: `node:sqlite` (`DatabaseSync`).
  Queries are Reylo `.sql` files.
- `databaseUrl` is a `file:` URL.
- On open: WAL, `synchronous = NORMAL`,
  `busy_timeout`, `foreign_keys = ON`.
- `transaction` (session resource):
  lazy `BEGIN IMMEDIATE`, commit or rollback
  on session end, as today.
- Writes queue: one write transaction
  per process at a time.
  `node:sqlite` is synchronous, so two sessions
  on one connection would mix statements.
- Reads use their own connection.
  WAL lets them run beside the writer.
- `migrate` holds `BEGIN EXCLUSIVE`
  in place of the advisory lock.
  It runs each new file in `migrations/`
  in name order and records it in
  `start_migrations`.
- `listen(channel)` polls a `start_notify`
  table by rowid; a write in the same process
  also wakes readers at once.
- `notify(channel, payload)` inserts
  one `start_notify` row in the open
  transaction.
  Old rows are trimmed on a timer.

### auth-sqlite

- Tables in a `.sql` migration.
- Better Auth gets `database.client`
  (the `DatabaseSync`), no adapter.

### sync-sqlite

- Tables in a `.sql` migration;
  JSON columns are `text`.
- Queries in `.sql` files.
- `database.notify` in place of `pg_notify`.
- No trigger: the publish step notifies
  in the same transaction.

## Not decided here

- Duke, 2026-10-28: SQLite set first.
- Postgres components (`database`, `auth`,
  `sync`, `mail`) keep Drizzle for now.
  Moving them to Reylo is its own ticket,
  after the SQLite set proves it.
- Hedl's own tables: app code, not Start.
- A `mail-sqlite` variant: on a second asker.
- A toolchain registry item. Until it
  exists, the SQLite items are
  starter-only: they need the starter's
  Reylo toolchain (TypeScript 7.1 beta,
  `reylo/vite`, `contentMappers`,
  `sqlite-dev-db`), so they do not
  install onto the `app` item yet.
