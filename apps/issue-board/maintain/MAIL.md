# Local mail worker

Start the local Postgres and Mailpit used by the board demo. Mailpit uses SMTP
127.0.0.1:11026 and HTTP 127.0.0.1:18026. Never use a real mail server for this trial.

Run these commands from apps/issue-board. The server applies migrations on its first request:

```bash
PORT=4327 HOST=127.0.0.1 vp dev
curl -f http://localhost:4327/ >/dev/null
```

In another terminal, build and run the worker:

```bash
pnpm run build:worker
DATABASE_URL=postgres://issue_board@127.0.0.1:15433/postgres \
SMTP_URL=smtp://127.0.0.1:11026 SMTP_FROM=board@example.test \
pnpm run worker
```

The worker does not run migrations. Start the server first. Stop the worker with
Ctrl-C, or send SIGTERM to its Node PID.

Other team members get alerts for issue creation, edits, moves, removal, and new
comments. The actor and non-members get no alert. A saved board change stores its
alert rows in the same transaction. The key is executionId:recipientId. A retry of
the same command cannot enqueue another alert.

Each worker locks at most 20 due rows with FOR UPDATE SKIP LOCKED. It holds those
locks until sending and updating the rows finish. Other workers skip those rows.
SMTP failures record the error and retry after 1, 2, 4, 8 seconds, up to 30 minutes.
After 12 failures, attempts=12 and sent_at=NULL mark the row dead. It stays in the
table for inspection, logs outbox.dead, and is never claimed again.
LISTEN board_outbox wakes the worker after inserts commit. A 30-second poll also
finds retries and covers missed notifications. Failed connects use a separate
backoff with jitter: 0.5–1 seconds initially, doubling to a 15–30 second cap.
Old connection events cannot shorten this timer. Retry deadlines are lower bounds;
a retry may wait for that next poll.

Delivery can repeat if the process dies after SMTP accepts a message but before
Postgres commits sent_at. SMTP and Postgres cannot commit together. The unique
key stops duplicate enqueue, not this crash case. A batch rollback can repeat its
earlier accepted messages too. There is no claim of exactly-once delivery.

The board sender uses 10-second connection, greeting, and socket-idle timeouts.
A stop finishes the current send, commits its result, and releases the rest of
the batch. A clean SIGTERM prints "outbox worker stopped". Close errors still fail
the process. The host also works with only environment values and no .env file.

The existing auth/profile demo mail still uses the starter sender. This outbox
owns board alerts only. No digest, cron, import, or new registry component is added.

Run the scripted demo and real-Postgres proofs after building the worker:

```bash
node maintain/demo.mjs
```

The demo owns one worker process and stops it by PID before running the live
proofs. Unit tests run serially with the PGlite preset. Only the live proof can
show that separate transactions skip each other's locked rows.

Rank-only moves still send alerts. Slice 6 may replace those with digest mail.
The app clock selects due rows, while the database clock sets their first next_at;
clock skew can delay a new row until a later poll. A future member-removal path
must also cancel that member's pending alerts.

Inspect dead rows with:

```sql
SELECT id, "to", attempts, last_error
FROM mail_outbox
WHERE sent_at IS NULL AND attempts >= 12;
```

## Daily digest

The same worker ticks before each batch and after each normal 30-second wake.
By default it queues today's digest at or after 09:00 UTC. A late restart catches
up for today. It does not backfill days when the worker was down. Set the typed
hour tag through the worker command when needed:

```bash
DIGEST_HOUR_UTC=9 pnpm run worker
```

Each member with open issues gets one message across all their current teams.
The text lists open issue keys, titles, states, and priorities, in team/number
order. Done and canceled issues are left out. Empty boards send no digest.
The key is digest:<user>:<yyyy-mm-dd>. The outbox's unique key and INSERT ON
CONFLICT DO NOTHING keep concurrent ticks and restarts from queuing a second row.
Sent and dead rows keep that receipt. The existing SMTP crash window still means
that delivery itself can repeat; this is one durable enqueue per UTC day.

The tick reads membership and issues in one SQL snapshot. Receipt insert order
uses sorted user IDs so concurrent ticks take unique-index locks in the same
order. Users who already have a receipt are excluded before aggregation.

Dead rows now stay outside mail_outbox_due's partial index. The sender also
honors SMTP URL credentials, IPv6 hosts, and implicit TLS on port 465. Trial mail
still goes only to local Mailpit. The auth proof uses a second local Mailpit at
127.0.0.1:11027 (HTTP 18027), configured with synthetic test credentials.

Start the second Mailpit for the credential proof in another terminal. These are
synthetic trial credentials. The flags follow the [Mailpit SMTP guide](https://mailpit.axllent.org/docs/configuration/smtp/).

```bash
MP_SMTP_AUTH='digest-user:p@ss-word' ~/.local/bin/mailpit \
  --listen 127.0.0.1:18027 --smtp 127.0.0.1:11027 \
  --smtp-auth-allow-insecure
```
