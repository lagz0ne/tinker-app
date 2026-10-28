# Plain functions

This list is checked against src, cmds, and tinker.
Callers include direct calls and typed callback registrations.
Repeated calls by one caller count once; self-calls do not count.
Tests and generated files do not count.

- **src/demo/contracts/commands.ts#readProfileCommand**
  - `raw`: `unknown`. From the profile request body; why: read its execution ID and profile input.
  - Callers:
    - `src/demo/backend/profile.server.ts#saveProfile.input`
    - `src/transport/profile.functions.ts#module`

- **src/demo/contracts/commands.ts#readTodoCommand**
  - `raw`: `unknown`. From the todo request body; why: read its execution ID and todo change.
  - Callers:
    - `src/demo/backend/todos.server.ts#changeTodo.input`
    - `src/transport/todos.functions.ts#module`

- **src/demo/errors.ts#raise**
  - `kind`: `N`. From the failing caller; why: choose the managed error.
  - `payload`: `Errors.Payload<N>`. From the failing caller; why: keep facts for that error.
  - Callers:
    - `src/demo/backend/auth.server.ts#currentUser.factory`
    - `src/demo/backend/counter.server.ts#incrementCounter.run`
    - `src/demo/backend/profile.server.ts#notifyProfile.run`
    - `src/demo/backend/profile.server.ts#retryNotification.run.callback1`
    - `src/demo/backend/profile.server.ts#saveProfile.run.callback1`
    - `src/demo/backend/sync.server.ts#bootstrapPrivate.run.callback1`
    - `src/demo/backend/sync.server.ts#replayPrivate.run`
    - `src/demo/backend/sync.server.ts#replayPublic.run`
    - `src/demo/backend/todos.server.ts#changeTodo.run`
    - `src/demo/contracts/profile-contract.ts#module`
    - `src/demo/contracts/todos-contract.ts#module`
    - `src/frontend/auth-actions.ts#signIn.input`
    - `src/frontend/auth-actions.ts#signIn.run`
    - `src/frontend/auth-actions.ts#signOut.run`
    - `src/frontend/profile-actions.ts#saveName.run`
    - `src/transport/result.server.ts#readReceipt`

- **src/demo/errors.ts#isError**
  - `error`: `unknown`. From a caught failure; why: narrow its payload.
  - `kind`: `N`. From the caller; why: select the expected error.
  - Callers:
    - `src/frontend/error-text.ts#errorText`
    - `src/frontend/Todos.tsx#showFailure.input`
    - `src/transport/result.server.ts#readReceipt`

- **src/frontend/error-text.ts#errorText**
  - `error`: `unknown`. From a form action failure; why: pick the shown message.
  - Callers:
    - `src/frontend/App.tsx#AccountForm`
    - `src/frontend/Profile.tsx#ProfileForm`

- **src/frontend/ui/classes.ts#cn**
  - `inputs`: `ClassValue[]`. From view class values; why: merge only these styles.
  - Callers:
    - `src/frontend/ui/button.tsx#Button`
    - `src/frontend/ui/card.tsx#Card`
    - `src/frontend/ui/card.tsx#CardAction`
    - `src/frontend/ui/card.tsx#CardContent`
    - `src/frontend/ui/card.tsx#CardDescription`
    - `src/frontend/ui/card.tsx#CardFooter`
    - `src/frontend/ui/card.tsx#CardHeader`
    - `src/frontend/ui/card.tsx#CardTitle`
    - `src/frontend/ui/input.tsx#Input`

- **src/transport/result.server.ts#readReceipt**
  - `result`: `RunResult<{ executionId: string }>`. From a settled mutation; why: turn its result into a network receipt.
  - Callers:
    - `src/transport/counter.functions.ts#updateCounter.callback`
    - `src/transport/profile.functions.ts#retryProfileNotification.callback`
    - `src/transport/profile.functions.ts#updateProfile.callback`
    - `src/transport/todos.functions.ts#updateTodo.callback`

- **tinker/base/main.ts#mainErrorCode**
  - `error`: `unknown`. From command startup; why: map only known config errors to 78.
  - Callers:
    - `cmds/server.ts#module.callback1`
    - `cmds/worker.ts#module.callback1`

- **tinker/base/main.ts#checkClosed**
  - `result`: `Scope.Result`. From a closed root; why: surface work and cleanup errors before exit.
  - Callers:
    - `cmds/server.ts#closed.closeRoots`
    - `cmds/server.ts#module.callback1`
    - `cmds/telemetry-worker.ts#module`
    - `cmds/worker.ts#module.callback1`

- **tinker/components/errors/errors.ts#raise**
  - `kind`: `N`. From a failed base action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Callers:
    - `tinker/base/server-entry.ts#renderRequest.callback`
    - `tinker/components/auth/stream.server.ts#lease.check`
    - `tinker/components/auth/stream.server.ts#lease.open`
    - `tinker/components/auth/stream.server.ts#lease.wait`
    - `tinker/components/http/http.server.ts#httpRequest.run.callback1`
    - `tinker/components/requests/render-lifetime.server.ts#retain`
    - `tinker/components/requests/start.ts#middleware.callback`
    - `tinker/components/sync-sqlite/client/sync.ts#client.execute`
    - `tinker/components/sync-sqlite/client/sync.ts#client.wait`
    - `tinker/components/sync-sqlite/client/sync.ts#syncClient.factory`
    - `tinker/components/sync-sqlite/history.server.ts#append`
    - `tinker/components/sync-sqlite/history.server.ts#find`
    - `tinker/components/sync-sqlite/history.server.ts#lock`
    - `tinker/components/sync-sqlite/history.server.ts#read`
    - `tinker/components/sync-sqlite/notifications.server.ts#subscribe`
    - `tinker/components/sync/client/sync.ts#client.execute`
    - `tinker/components/sync/client/sync.ts#client.wait`
    - `tinker/components/sync/client/sync.ts#syncClient.factory`
    - `tinker/components/sync/history.server.ts#append`
    - `tinker/components/sync/history.server.ts#find`
    - `tinker/components/sync/history.server.ts#lock`
    - `tinker/components/sync/history.server.ts#read`
    - `tinker/components/sync/notifications.server.ts#subscribe`
    - `tinker/components/telemetry/ingest.server.ts#receiveTelemetry.run`

- **tinker/components/errors/errors.ts#fail**
  - `kind`: `N`. From a failed base action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Callers:
    - `tinker/components/database-sqlite/database.server.ts#guardQuery`
    - `tinker/components/database-sqlite/database.server.ts#migrate.run`
    - `tinker/components/database-sqlite/database.server.ts#tx.take`
    - `tinker/components/database-sqlite/database.server.ts#tx.transaction`
    - `tinker/components/database/database.server.ts#lease.begin`
    - `tinker/components/database/database.server.ts#lease.check`
    - `tinker/components/database/database.server.ts#migrate.run`
    - `tinker/components/database/database.server.ts#tx.transaction`
    - `tinker/components/errors/errors.ts#raise`
    - `tinker/components/requests/result.server.ts#readResult`
    - `tinker/components/sync-sqlite/client/sync.ts#client.leave`
    - `tinker/components/sync-sqlite/client/sync.ts#stop.stop`
    - `tinker/components/sync-sqlite/client/sync.ts#syncClient.factory.callback1`
    - `tinker/components/sync/client/sync.ts#client.leave`
    - `tinker/components/sync/client/sync.ts#stop.stop`
    - `tinker/components/sync/client/sync.ts#syncClient.factory.callback1`

- **tinker/components/errors/errors.ts#isError**
  - `error`: `unknown`. From a caught failure; why: narrow its payload.
  - `kind`: `N`. From the caller; why: select the expected error.
  - Callers:
    - `src/frontend/error-text.ts#errorText`
    - `src/routes/api.sync.ts#Route.GET`
    - `src/transport/result.server.ts#readReceipt`

- **tinker/components/requests/result.server.ts#readResult**
  - `result`: `RunResult<T>`. From a settled boundary call; why: return its value or raise its failure.
  - Callers:
    - `src/routes/api.auth.$.ts#Route.GET`
    - `src/routes/api.auth.$.ts#Route.POST`
    - `src/routes/api.health.ts#Route.GET`
    - `src/routes/api.sync.ts#Route.GET`
    - `src/routes/api.telemetry.ts#Route.POST`
    - `src/transport/profile.functions.ts#getProfile.callback`
    - `src/transport/todos.functions.ts#getTodos.callback`
    - `tinker/components/sync-sqlite/functions.ts#getAccount.callback`
    - `tinker/components/sync-sqlite/functions.ts#getBootstrap.callback`
    - `tinker/components/sync-sqlite/notifications.server.ts#share`
    - `tinker/components/sync/functions.ts#getAccount.callback`
    - `tinker/components/sync/functions.ts#getBootstrap.callback`
    - `tinker/components/sync/notifications.server.ts#share`

- **tinker/components/sync-sqlite/notice.ts#accountNotice**
  - `accountId`: `string`. From the auth path; why: the account whose streams must re-read.
  - Callers:
    - `tinker/components/sync-sqlite/notifications.server.ts#notifications.factory`
    - `tinker/components/sync-sqlite/publish.server.ts#publishAccountNotice.run`

- **tinker/components/sync/notice.ts#accountNotice**
  - `accountId`: `string`. From the auth path; why: the account whose streams must re-read.
  - Callers:
    - `tinker/components/sync/notifications.server.ts#notifications.factory`
    - `tinker/components/sync/publish.server.ts#publishAccountNotice.run`

- **tinker/components/telemetry/records.ts#encodeValue**
  - `value`: `unknown`. From a span or log attribute; why: bound and safely encode its wire value.
  - Callers:
    - `tinker/components/telemetry/drain.server.ts#owned.log`
    - `tinker/components/telemetry/observer.ts#log`
    - `tinker/components/telemetry/records.ts#spanBody`
    - `tinker/components/telemetry/thread.server.ts#owned.encodeAll`

- **tinker/components/telemetry/records.ts#spanBody**
  - `span`: `Telemetry.SpanFields`. From Core's export callback or a worker line; why: the fields to shape.
  - `encoded`: `boolean`. From a worker line's flag; why: its values are already `encodeValue` output.
  - Callers:
    - `tinker/components/telemetry/drain.server.ts#owned.span`
    - `tinker/components/telemetry/observer.ts#export`
