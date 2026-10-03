# Your Start app

A shared counter, accounts, profiles, and private todos.
The app uses Postgres, Better Auth, and SMTP.
Victoria stores traces and logs.

## Start

Install this starter through shadcn into your project.
Core and React must be installed from packed releases first.
They are not published to npm yet.
The starter copies its package file and all project checks.

From your project folder:

```bash
cp .env.example .env
npm install
```

Set `AUTH_SECRET` in `.env` to a long random value.
The other sample values point at the local compose stack.
SMTP user and password may be empty for Mailpit.

```bash
docker compose pull
docker compose up -d --wait
npm run dev
```

Open `http://localhost:4318`.
Make an account, save a name, and add a todo.
Open `http://localhost:18025` to see mail in Mailpit.
Open two tabs to see shared changes.
Each account sees only its own profile and todos.
Startup applies the checked-in migrations.

For a built app:

```bash
npm run build
npm start
```

The Node host reads `.env`.
The dev command also reads `.env`.
`HOST` and `PORT` set the listen address.
Keep `PUBLIC_ORIGIN` equal to the URL you open.
All settings and compose ports are in `.env.example`.

## Layout

- `src/scaffold/`: fixed Start, sync, and trace setup.
  Update it through the registry; do not edit it.
- `src/lib/tinker.ts`: your browser values and `Register` types.
- `src/lib/tinker.server.ts`: your server values.
- `src/backend/`: database, auth, mail, and feature operations.
- `src/frontend/`: saved data, drafts, actions, and views.
- `src/contracts/`: readers for raw input and wire values.
- `src/transport/`: Start server functions.
- `src/routes/`: pages and HTTP routes.
- `drizzle/`: checked-in database migrations.
- `tests/`: scope tests and database/mail presets.
- `.agents/skills/`: short guides for app changes.

`src/routeTree.gen.ts` is generated.
Never edit it by hand.
Native clients load inside their resource factories.
The browser build refuses server imports.

## Rules

Use a tag for settings, data for changing state,
a resource for a shared client, and an operation for an action.
Code outside these four forms needs a TSDoc reason.
Read `AGENTS.md` and the skill for the work you are doing.
The scaffold reaches your code through the two lib seams.
`Register` fills its open types with your feature bodies.

A mutation returns an execution ID.
Sync applies saved changes, then ends the wait for that ID.
Remote changes use that same path.
Draft text stays separate from saved data.
A profile save is complete after commit and mail acceptance.
Mail failure gives a partial result and keeps the saved name.
Retry sends mail without saving the name again.
The profile shows your email and the last result.

The stream checks auth at open, once per wake, and on heartbeats.
Private route guards check the account with the server each time.
Route loads reuse the tab's snapshot while the account stays the same.
A signed-out private route checks only the account before redirecting.
Account exit cancels waits and starts a new snapshot lifetime.

## Checks

```bash
npm run build
npm run typecheck
npm test
npm run test:seam
npm run test:boundary
npm run test:schema
```

`npm run check` runs the project gates together.
Tests run operations through small scopes.
They use presets with PGlite and real auth and database code.
There are no mocks and no timing claims.
The seam check rejects imports outside the fixed folder.
The browser check proves server imports fail the build.
The schema check proves generation adds no duplicate tables.

## Promises tested through scopes

- Real accounts can sign up, sign in, sign out, and save a profile.
- Signed-out private writes open no transaction.
- Refused work leaves the server root usable.
- Failed transactions keep old data and publish no saved change.
- A native commit failure never returns a saved profile.
- Email check and reset callbacks use the declared mail action.
- Accounts can read and change only their own todos and event stream.
- Another account's todo ID cannot change or delete its row.
- Empty titles and caller-selected owners are refused.
- Concurrent public writes replay in commit order.
- Repeated execution IDs do not repeat saved effects.
- Events before receipts finish waits after saved records are applied.
- Replayed events and old snapshots keep newer records and drafts.
- Account exit stops waits and ignores late old responses.
- Failed mail keeps the name and retry sends only mail.
- Committed profile work finishes after its request exits.
- Saved names stay readable while duplicate requests share a send.
- Unbound middleware fails before calling its next step.
- A body ending or being cancelled closes its session and work.
- Commit wakes SSE; rollback publishes no wake.
- SSE replays saved events and refuses another account's cursor.
- A revoked session receives no queued private rows.
- A quiet private stream closes at the heartbeat after sign-out.
- A final result replay completes a wait after disconnect.
- Finished traces and Pino logs reach their HTTP receivers.
- Storage failure keeps bounded records for retry.
- Accepted telemetry frees the byte budget for later records.
- Browser ingest refuses foreign origins, bad shapes, and large bodies.
- Owner close flushes finished records without a scheduled browser timer.
- A stuck receiver is aborted by the owned Core clock during close.
- Stalled uploads and storage requests stop with their owner.
- A stream checks the session once at open and once for the next wake.
- A signed-out private redirect loads one snapshot across separate renders.
- A private route check clears cached records after another tab signs out.
- Sign-in, an old stream account event, and route loads fetch one signed-in snapshot.

## Limits

Event history has no retention rule yet.
SSE replays stored events; it is not a durable job queue.
A crash after commit can leave mail without a final result.
A crash after SMTP acceptance can cause a resend.
One send across several server processes is not promised.
SMTP acceptance means the server accepted mail.
Mailpit lets you see that message in local development.
Storage failure can drop records when its bounded queue fills.
