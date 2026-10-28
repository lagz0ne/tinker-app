# SQLite as a second database

Date: 2026-10-28. Status: proposed.
Asked by: Hedl on Tinker, gap G0.
Duke, 2026-10-26: "SQLite is just fine".
Duke, 2026-10-26: no workarounds in Hedl;
a Tinker gap is fixed in Tinker.

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

## Proposal (pending Duke's card)

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

- Driver: `node:sqlite` with
  `drizzle-orm/node-sqlite`.
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
- `listen(channel)` polls a `start_notify`
  table by rowid; a write in the same process
  also wakes readers at once.
- `notify(channel, payload)` inserts
  one `start_notify` row in the open
  transaction.
  Old rows are trimmed on a timer.

### auth-sqlite

- `sqliteTable` schema.
- Better Auth `provider: "sqlite"`.
- No other change.

### sync-sqlite

- `sqliteTable` schema; JSON columns are
  `text` with `mode: "json"`.
- `database.notify` in place of `pg_notify`.
- No trigger: the publish step notifies
  in the same transaction.

## Not decided here

- Hedl's own tables: app code, not Start.
- A `mail-sqlite` variant: on a second asker.
