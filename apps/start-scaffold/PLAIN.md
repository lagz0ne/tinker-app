# Plain functions

This list is checked against src.
Callers include direct calls and typed callback registrations.
Repeated calls by one caller count once; self-calls do not count.
Tests and generated files do not count.

- **src/contracts/commands.ts#readProfileCommand**
  - `raw`: `unknown`. From the profile request body; why: read its execution ID and profile input.
  - Callers:
    - `src/backend/profile.ts#saveProfile.input`
    - `src/transport/profile.functions.ts#module`

- **src/contracts/commands.ts#readTodoCommand**
  - `raw`: `unknown`. From the todo request body; why: read its execution ID and todo change.
  - Callers:
    - `src/backend/todos.ts#changeTodo.input`
    - `src/transport/todos.functions.ts#module`

- **src/contracts/profile.ts#readProfileInput**
  - `raw`: `unknown`. From the profile command or draft; why: validate only the saved name.
  - Callers:
    - `src/contracts/commands.ts#readProfileCommand`
    - `src/frontend/actions.ts#saveName.input`

- **src/contracts/sync.ts#readFeatureEvent**
  - `raw`: `unknown`. From a saved event row; why: validate its feature body before replay.
  - Callers:
    - `src/backend/sync.ts#replayPrivate.run`
    - `src/backend/sync.ts#replayPublic.run`

- **src/contracts/todos.ts#readTodoChange**
  - `raw`: `unknown`. From the todo command or form; why: validate one todo change.
  - Callers:
    - `src/contracts/commands.ts#readTodoCommand`
    - `src/frontend/Todos.tsx#saveTodo.input`

- **src/errors.ts#raise**
  - `kind`: `N`. From the failing caller; why: choose the managed error.
  - `payload`: `Errors.Payload<N>`. From the failing caller; why: keep facts for that error.
  - Callers:
    - `src/backend/auth.ts#currentUser.factory`
    - `src/backend/counter.ts#incrementCounter.run.callback1`
    - `src/backend/profile.ts#notifyProfile.run`
    - `src/backend/profile.ts#retryNotification.run.callback1`
    - `src/backend/profile.ts#saveProfile.run.callback1`
    - `src/backend/sync.ts#bootstrapPrivate.run.callback1`
    - `src/backend/sync.ts#replayPrivate.run`
    - `src/backend/todos.ts#changeTodo.run.callback1`
    - `src/contracts/profile.ts#readProfileInput`
    - `src/contracts/todos.ts#readTodoChange`
    - `src/frontend/actions.ts#saveName.run`
    - `src/frontend/actions.ts#signIn.input`
    - `src/frontend/actions.ts#signIn.run`
    - `src/frontend/actions.ts#signOut.run`
    - `src/transport/result.server.ts#readReceipt`

- **src/errors.ts#isError**
  - `error`: `unknown`. From a caught failure; why: narrow its payload.
  - `kind`: `N`. From the caller; why: select the expected error.
  - Callers:
    - `src/frontend/App.tsx#errorText`
    - `src/frontend/Todos.tsx#showFailure.input`
    - `src/routes/api.sync.ts#Route.GET`
    - `src/routes/api.telemetry.ts#Route.POST`
    - `src/transport/result.server.ts#readReceipt`

- **src/frontend/App.tsx#errorText**
  - `error`: `unknown`. From a form action failure; why: pick the shown message.
  - Callers:
    - `src/frontend/App.tsx#AccountForm`
    - `src/frontend/App.tsx#ProfileForm`

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

- **src/scaffold/backend/result.server.ts#readResult**
  - `result`: `RunResult<T>`. From a settled boundary call; why: return its value or raise its failure.
  - Callers:
    - `src/routes/api.auth.$.ts#Route.GET`
    - `src/routes/api.auth.$.ts#Route.POST`
    - `src/routes/api.sync.ts#Route.GET`
    - `src/routes/api.telemetry.ts#Route.POST`
    - `src/scaffold/sync.functions.ts#getAccount.callback`
    - `src/scaffold/sync.functions.ts#getBootstrap.callback`
    - `src/transport/profile.functions.ts#getProfile.callback`
    - `src/transport/todos.functions.ts#getTodos.callback`

- **src/scaffold/backend/settings.server.ts#readSettings**
  - `env`: `Record<string, string | undefined>`. From the entry environment values; why: validate app settings once.
  - Callers:
    - `src/scaffold/frontend/router.tsx#readTelemetrySettings.callback`
    - `src/server.ts#start`

- **src/scaffold/errors.ts#fail**
  - `kind`: `N`. From a failed scaffold action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Callers:
    - `src/scaffold/errors.ts#raise`
    - `src/scaffold/frontend/sync.ts#client.leave`
    - `src/scaffold/frontend/sync.ts#stop.stop`
    - `src/scaffold/frontend/sync.ts#syncClient.factory.callback1`

- **src/scaffold/errors.ts#raise**
  - `kind`: `N`. From a failed scaffold action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Callers:
    - `src/scaffold/backend/events.ts#append`
    - `src/scaffold/backend/events.ts#find`
    - `src/scaffold/backend/events.ts#lock`
    - `src/scaffold/backend/http.ts#httpRequest.run.callback1`
    - `src/scaffold/backend/notifications.ts#subscribe`
    - `src/scaffold/backend/result.server.ts#readResult`
    - `src/scaffold/backend/settings.server.ts#readSettings`
    - `src/scaffold/backend/stream.ts#open`
    - `src/scaffold/frontend/sync.ts#client.execute`
    - `src/scaffold/frontend/sync.ts#client.wait`
    - `src/scaffold/start.ts#middleware.callback`
    - `src/scaffold/telemetry/ingest.server.ts#receiveTelemetry.run`
    - `src/server.ts#renderRequest.callback`

- **src/scaffold/sync.ts#readExecution**
  - `raw`: `unknown`. From a mutation request; why: validate its execution ID.
  - Callers:
    - `src/backend/counter.ts#incrementCounter.input`
    - `src/backend/profile.ts#notifyProfile.input`
    - `src/transport/counter.functions.ts#module`

- **src/scaffold/sync.ts#readRetry**
  - `raw`: `unknown`. From a retry request; why: validate both execution IDs.
  - Callers:
    - `src/backend/profile.ts#retryNotification.input`
    - `src/transport/profile.functions.ts#module`

- **src/scaffold/telemetry/records.ts#encodeValue**
  - `value`: `unknown`. From a span or log attribute; why: bound and safely encode its wire value.
  - Callers:
    - `src/scaffold/telemetry/index.ts#export`
    - `src/scaffold/telemetry/index.ts#log`

- **src/transport/result.server.ts#readReceipt**
  - `result`: `RunResult<{ executionId: string }>`. From a settled mutation; why: turn its result into a network receipt.
  - Callers:
    - `src/transport/counter.functions.ts#updateCounter.callback`
    - `src/transport/profile.functions.ts#retryProfileNotification.callback`
    - `src/transport/profile.functions.ts#updateProfile.callback`
    - `src/transport/todos.functions.ts#updateTodo.callback`
