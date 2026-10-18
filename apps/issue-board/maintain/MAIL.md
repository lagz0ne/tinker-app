# Local mail worker

Start the local Postgres and Mailpit used by the board demo. Mailpit uses SMTP
127.0.0.1:11026 and HTTP 127.0.0.1:18026. Never use a real mail server for this trial.

Run these commands from apps/issue-board. Every process awaits the shared migration lock before doing work:

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

Server, worker, and CLI may start together. One connection owns migration; the
others wait up to DATABASE_MIGRATION_TIMEOUT_MS (default 5000). Stop the worker with
Ctrl-C, or send SIGTERM to its Node PID.

Other team members get alerts for issue creation, edits, moves, removal, and new
comments. The actor and non-members get no alert. A saved board change stores its
alert rows in the same transaction. The key is executionId:recipientId. A retry of
the same command cannot enqueue another alert.

Each worker claims up to 20 due rows with one UPDATE and FOR UPDATE SKIP LOCKED.
The claim commits its token, expiry, and attempts before any send. SMTP holds no
row locks. Each acknowledgement commits separately and requires the token.
OUTBOX_LEASE_MS defaults to 180000. Expired leases recover after a crash; twelve
consumed claims leave dead_at. Soft stop finishes the current send and releases
unstarted claims; their consumed attempts remain. SMTP can deliver twice after
acceptance followed by a lost acknowledgement.

Delivery can repeat if the process dies after SMTP accepts a message but before
Postgres commits sent_at. SMTP and Postgres cannot commit together. The unique
key stops duplicate enqueue, not this crash case. A failed acknowledgement leaves
the lease recoverable. There is no claim of exactly-once delivery.

The public sender has a 3-second total send deadline, including all SMTP stages.
OUTBOX_SMTP_TIMEOUT_MS may shorten it, but cannot exceed 3000 ms. A timed-out
transport has its owned TCP sockets destroyed, then is closed and replaced
before the next attempt. Nodemailer gets these sockets through its public
getSocket hook; pooling stays on. Transaction statements
are bounded to 1000 ms by default, with a 500 ms lock wait. The typed limits cap
statements at 2000 ms and lock waits at 1000 ms. The worker also fixes checkout to 1000 ms. Thus send + checkout + record + COMMIT uses
at most 6 seconds with its configured bounds; even a final rollback fits inside the 10-second host grace.
A stop finishes the current send, commits its result, and releases the rest of
the batch. A clean SIGTERM prints "outbox worker stopped". Close errors still fail
the process. SIGINT ends with code 130; SIGTERM ends with 143. The host waits
for cleanup and flushes output before setting its code. A 10-second host
deadline is the only hard stop. The host also works with only environment values and no .env file.

Auth verification/reset mail now uses this same durable mail queue. Better Auth
writes through its own pool adapter, so its callback awaits a separate committed
enqueue. Profile retains its stored notification/result flow. This outbox
owns board alerts and daily digests. No import or new registry component is added.

Run the scripted demo and real-Postgres proofs after building the worker:

```bash
node maintain/demo.mjs
```

The demo owns one worker process and stops it by PID before running the live
proofs. Unit tests run serially with the PGlite preset. Only the live proof can
show that separate transactions skip each other's locked rows.

Rank-only moves still send alerts alongside daily digests.
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

The same worker checks the day before draining batches and after each wake.
A scope-held day gate runs the heavy SQL once per worker per UTC day after the hour.
Members who become eligible after that snapshot wait until tomorrow. A fresh
worker after a restart may catch them today; existing durable receipts still stop
a second enqueue. A failed digest logs digest.failed and does not block alerts. It waits at least
30 seconds before retrying, even when alert notifications keep waking the worker.
By default it queues today's digest at or after 09:00 UTC. A late restart catches
up for today. It does not backfill days when the worker was down. Set the typed
hour tag through the worker command when needed:

```bash
DIGEST_HOUR_UTC=9 pnpm run worker
```

Each member with open issues gets one message across all their current teams.
The text lists open issue keys, titles, states, and priorities, in team/number
order, limited to 50 issues followed by the remaining count. Done and canceled
issues are left out. Empty boards send no digest.
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

Live shutdown and SQL bounds (local Postgres required; run serially):

```bash
node maintain/proof-sql-cancel.mjs
node maintain/proof-alert-grace.mjs
node maintain/proof-bounds-controls.mjs
```

The controls remove SQL bounds or the total send deadline in scratch modules.
Each must fail its named deadline check. They are live proofs, so test:proofs
does not run them without Postgres.

Mail and sync use database.listen with explicit channel names. A listener still
needs a dedicated pool connection; its owner closes it on stop or reconnect.
The mail wait loop retains its capped reconnect backoff, jitter, and poll.

Run `pnpm run test:migrations` with local Postgres. It applies the actual chain
to a fresh database and checks the transition-table trigger and ordered wakes.
The controls remove the trigger, change its channel, or drop the empty guard:
each still passes schema generation but fails the live contract gate.
