# CSV import

Run from apps/issue-board after the server has applied migrations:

```bash
pnpm run build:cli
DATABASE_URL=postgres://issue_board@127.0.0.1:15433/postgres \
node maintain/cli.mjs --file issues.csv --team ENG --actor ada@example.test
```

The team must exist. The actor email must belong to a member of that team.
This is a trusted local command. It does not sign in or start a server.
The host reads args and env, owns signals and output, and waits for closed.
The command calls exit after cleanup. Codes are 0 for success, 64 for bad
args, 65 for bad CSV data, 75 for a temporary membership race (retry), 78 for bad config, and 1 for an unexpected error.
SIGINT ends with 130; SIGTERM ends with 143. The first stop code wins.
The command fills typed tags and owns one root. It never runs migrations.

Example issues.csv:

```csv
ID,Title,Description,Status,Priority,Assignee
OLD-1,"Fix login, please","Keep the ""Remember me"" box",Todo,High,grace@example.test
OLD-2,Add search,,Backlog,No priority,
```

ID and Title are required. The other shown
[Linear export columns](https://linear.app/docs/exporting-data) are optional.
Other columns are ignored. Status accepts Backlog, Todo, In Progress, Done,
and Canceled. Missing Status means Backlog. Priority accepts No priority,
Urgent, High, Medium, Low, or 0 through 4. Missing Priority means No priority.
Assignee is a team member's email, or blank for no assignee.
Missing Description and Assignee mean empty text and no assignee.

CSV uses RFC 4180 quotes, doubled quotes, commas, and quoted line breaks.
CRLF, LF, and a UTF-8 BOM are accepted. Bad quotes, wrong cell counts,
duplicate headers, blank IDs, repeated IDs, bad titles, unknown states, and
bad priorities fail before writes begin. The file is read in full.

The import runner opens a child session for each group of at most 100 rows.
The session owns database.transaction. Its first write starts BEGIN. Its close commits before the runner
counts or reports the group. The batch and its steps only use that resource. A failed group
rolls back its issue rows, counter, events, and mail. Earlier groups stay
saved. Fix the input and run it again to finish.

ID maps to external_id inside the chosen team. It does not replace the local
issue number. New rows get the next team number. Changed rows keep their ID
and number, and raise their version so stale board edits fail. A title edit
keeps its rank; changing state puts it last in that state. The CSV row order
sets the order of new cards. An unchanged row changes nothing, including mail
and events. An import never deletes an issue.

The import locks member streams in sorted ID order, checks membership again,
then locks the team row. It writes each changed row to every member stream
through eventHistory in the same transaction, with a complete result for the actor. Open boards fill without a
reload. Each changed row queues alerts for the other members through the
same outbox rules as board edits. The actor and non-members get no alert.

Run the serial scope checks and live Postgres proof:

```bash
vp test tests/import.test.ts tests/worker.test.ts --maxWorkers=1 --no-file-parallelism
node maintain/proof-import.mjs
```

The full demo opens an empty CSV board, imports 201 rows with the built CLI,
checks batches of 100, 100, and 1, and reruns the file with zero changes.
All trial mail stays in local Mailpit.

Run the fault controls after the server has applied migrations:

```bash
node maintain/proof-import-controls.mjs
node maintain/proof-prior-controls.mjs
node maintain/proof-transaction.mjs
node maintain/proof-transaction-controls.mjs
```

Each control writes a broken scratch copy, requires its check to fail, and removes
the copy. This covers stream order, the team lock, membership joins, row events,
peer mail, replay, update versions, rollback, the digest SQL replay, its conflict guard, and backoff.
The real source stays unchanged.

The prior controls also break the inherited numbering, lock order, comments,
outbox batch size, SMTP login, and worker stop proofs. Run those after the
demo has made its current-day digest receipts. All controls run one at a time.

The transaction proof holds a real COMMIT and checks that the server sends no
response bytes. It then refuses COMMIT with a deferred constraint and requires
a client error, with no accepted receipt or saved rows. Two broken scratch
builds prove these checks fail. Four resource faults check lazy BEGIN, rollback,
single end, and TransactionEnded. A real CLI run also checks that one bad row
rolls back its batch while the prior batch stays saved.
