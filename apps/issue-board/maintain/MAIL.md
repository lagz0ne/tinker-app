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
LISTEN board_outbox wakes the worker after inserts commit. A 30-second poll also
finds retries and covers missed notifications. Retry deadlines are lower bounds;
a retry may wait for that next poll.

Delivery can repeat if the process dies after SMTP accepts a message but before
Postgres commits sent_at. SMTP and Postgres cannot commit together. The unique
key stops duplicate enqueue, not this crash case. A batch rollback can repeat its
earlier accepted messages too. There is no claim of exactly-once delivery.

The existing auth/profile demo mail still uses the starter sender. This outbox
owns board alerts only. No digest, cron, import, or new registry component is added.

Run the scripted demo and real-Postgres proofs after building the worker:

```bash
node maintain/demo.mjs
```

The demo owns one worker process and stops it by PID before running the live
proofs. Unit tests run serially with the PGlite preset. Only the live proof can
show that separate transactions skip each other's locked rows.
