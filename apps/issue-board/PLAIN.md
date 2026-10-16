# Plain functions

This list is checked against src, cmds, and tinker.
Callers include direct calls and typed callback registrations.
Repeated calls by one caller count once; self-calls do not count.
Tests and generated files do not count.

- **cmds/server.ts#ended**
  - `result`: `Scope.Result`. From a root's closed promise; why: report its first failure after cleanup.
  - Callers:
    - `cmds/server.ts#closed.closeRoots`
    - `cmds/server.ts#main`

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
    - `src/backend/comments.server.ts#addComment.run.callback1`
    - `src/backend/issues.server.ts#changeIssue.run.callback1`
    - `src/backend/teams.server.ts#changeTeam.run.callback1`
    - `src/backend/teams.server.ts#changeTeam.run.callback2`
    - `src/backend/teams.server.ts#readTeam.run`
    - `src/demo/backend/auth.server.ts#currentUser.factory`
    - `src/demo/backend/counter.server.ts#incrementCounter.run.callback1`
    - `src/demo/backend/profile.server.ts#notifyProfile.run`
    - `src/demo/backend/profile.server.ts#retryNotification.run.callback1`
    - `src/demo/backend/profile.server.ts#saveProfile.run.callback1`
    - `src/demo/backend/sync.server.ts#bootstrapPrivate.run.callback1`
    - `src/demo/backend/sync.server.ts#replayPrivate.run`
    - `src/demo/backend/sync.server.ts#replayPublic.run`
    - `src/demo/backend/todos.server.ts#changeTodo.run.callback1`
    - `src/demo/contracts/profile-contract.ts#module`
    - `src/demo/contracts/todos-contract.ts#module`
    - `src/frontend/auth-actions.ts#signIn.input`
    - `src/frontend/auth-actions.ts#signIn.run`
    - `src/frontend/auth-actions.ts#signOut.run`
    - `src/frontend/Comments.tsx#submitComment.run`
    - `src/frontend/Issues.tsx#saveIssue.run`
    - `src/frontend/profile-actions.ts#saveName.run`
    - `src/frontend/Teams.tsx#saveTeam.run`
    - `src/transport/result.server.ts#readReceipt`

- **src/demo/errors.ts#isError**
  - `error`: `unknown`. From a caught failure; why: narrow its payload.
  - `kind`: `N`. From the caller; why: select the expected error.
  - Callers:
    - `src/frontend/error-text.ts#errorText`
    - `src/frontend/Todos.tsx#showFailure.input`
    - `src/transport/result.server.ts#readReceipt`
    - `src/transport/result.server.ts#refusal.callback`

- **src/frontend/error-text.ts#errorText**
  - `error`: `unknown`. From a form action failure; why: pick the shown message.
  - Callers:
    - `src/frontend/App.tsx#AccountForm`
    - `src/frontend/Comments.tsx#Comments`
    - `src/frontend/Issues.tsx#Issues`
    - `src/frontend/Profile.tsx#ProfileForm`
    - `src/frontend/Teams.tsx#Teams`

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
    - `src/transport/comments.functions.ts#postComment.callback`
    - `src/transport/counter.functions.ts#updateCounter.callback`
    - `src/transport/issues.functions.ts#updateIssue.callback`
    - `src/transport/profile.functions.ts#retryProfileNotification.callback`
    - `src/transport/profile.functions.ts#updateProfile.callback`
    - `src/transport/teams.functions.ts#updateTeam.callback`
    - `src/transport/todos.functions.ts#updateTodo.callback`

- **tinker/components/errors/errors.ts#raise**
  - `kind`: `N`. From a failed base action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Callers:
    - `tinker/base/server-entry.ts#renderRequest.callback`
    - `tinker/components/http/http.server.ts#httpRequest.run.callback1`
    - `tinker/components/requests/render-lifetime.server.ts#retain`
    - `tinker/components/requests/start.ts#middleware.callback`
    - `tinker/components/sync/client/sync.ts#client.execute`
    - `tinker/components/sync/client/sync.ts#client.wait`
    - `tinker/components/sync/client/sync.ts#syncClient.factory`
    - `tinker/components/sync/history.server.ts#append`
    - `tinker/components/sync/history.server.ts#find`
    - `tinker/components/sync/history.server.ts#lock`
    - `tinker/components/sync/notifications.server.ts#subscribe`
    - `tinker/components/sync/stream.server.ts#lease.check`
    - `tinker/components/sync/stream.server.ts#lease.open`
    - `tinker/components/sync/stream.server.ts#lease.wait`
    - `tinker/components/telemetry/ingest.server.ts#receiveTelemetry.run`

- **tinker/components/errors/errors.ts#fail**
  - `kind`: `N`. From a failed base action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Callers:
    - `tinker/components/errors/errors.ts#raise`
    - `tinker/components/requests/result.server.ts#readResult`
    - `tinker/components/sync/client/sync.ts#client.leave`
    - `tinker/components/sync/client/sync.ts#stop.stop`
    - `tinker/components/sync/client/sync.ts#syncClient.factory.callback1`

- **tinker/components/errors/errors.ts#isError**
  - `error`: `unknown`. From a caught failure; why: narrow its payload.
  - `kind`: `N`. From the caller; why: select the expected error.
  - Callers:
    - `src/frontend/error-text.ts#errorText`
    - `src/routes/api.sync.ts#Route.GET`

- **tinker/components/requests/result.server.ts#readResult**
  - `result`: `RunResult<T>`. From a settled boundary call; why: return its value or raise its failure.
  - Callers:
    - `src/routes/api.auth.$.ts#Route.GET`
    - `src/routes/api.auth.$.ts#Route.POST`
    - `src/routes/api.health.ts#Route.GET`
    - `src/routes/api.sync.ts#Route.GET`
    - `src/routes/api.telemetry.ts#Route.POST`
    - `src/transport/greet.functions.ts#runGreet.callback`
    - `src/transport/issues.functions.ts#getTeamMembers.callback`
    - `src/transport/profile.functions.ts#getProfile.callback`
    - `src/transport/todos.functions.ts#getTodos.callback`
    - `tinker/components/sync/functions.ts#getAccount.callback`
    - `tinker/components/sync/functions.ts#getBootstrap.callback`
    - `tinker/components/sync/notifications.server.ts#share`

- **tinker/components/sync/notice.ts#accountNotice**
  - `accountId`: `string`. From the auth path; why: the account whose streams must re-read.
  - Callers:
    - `tinker/components/sync/notifications.server.ts#notifications.factory`
    - `tinker/components/sync/publish.server.ts#publishAccountNotice.run`

- **tinker/components/telemetry/records.ts#encodeValue**
  - `value`: `unknown`. From a span or log attribute; why: bound and safely encode its wire value.
  - Callers:
    - `tinker/components/telemetry/observer.ts#export`
    - `tinker/components/telemetry/observer.ts#log`
