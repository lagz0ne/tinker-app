# Plain functions

This list is checked against src.
Sites include direct calls and callbacks passed to their owner.
Tests and generated files do not count.

- **src/contracts/commands.ts#readProfileCommand**
  - `raw`: `unknown`. From the profile request body; why: read its execution ID and profile input.
  - Sites:
    - `src/backend/profile.ts`: 1 site(s).
    - `src/transport/profile.functions.ts`: 1 site(s).

- **src/contracts/commands.ts#readTodoCommand**
  - `raw`: `unknown`. From the todo request body; why: read its execution ID and todo change.
  - Sites:
    - `src/backend/todos.ts`: 1 site(s).
    - `src/transport/todos.functions.ts`: 1 site(s).

- **src/contracts/profile.ts#readProfileInput**
  - `raw`: `unknown`. From the profile command or draft; why: validate only the saved name.
  - Sites:
    - `src/contracts/commands.ts`: 1 site(s).
    - `src/frontend/actions.ts`: 1 site(s).

- **src/contracts/sync.ts#readFeatureEvent**
  - `raw`: `unknown`. From a saved event row; why: validate its feature body before replay.
  - Sites:
    - `src/backend/sync.ts`: 2 site(s).

- **src/contracts/todos.ts#readTodoChange**
  - `raw`: `unknown`. From the todo command or form; why: validate one todo change.
  - Sites:
    - `src/contracts/commands.ts`: 1 site(s).
    - `src/frontend/Todos.tsx`: 1 site(s).

- **src/errors.ts#raise**
  - `kind`: `N`. From the failing caller; why: choose the managed error.
  - `payload`: `Errors.Payload<N>`. From the failing caller; why: keep facts for that error.
  - Sites:
    - `src/backend/auth.ts`: 1 site(s).
    - `src/backend/counter.ts`: 1 site(s).
    - `src/backend/profile.ts`: 3 site(s).
    - `src/backend/sync.ts`: 2 site(s).
    - `src/backend/todos.ts`: 1 site(s).
    - `src/contracts/profile.ts`: 1 site(s).
    - `src/contracts/todos.ts`: 1 site(s).
    - `src/frontend/actions.ts`: 4 site(s).
    - `src/transport/result.server.ts`: 1 site(s).

- **src/errors.ts#isError**
  - `error`: `unknown`. From a caught failure; why: narrow its payload.
  - `kind`: `N`. From the caller; why: select the expected error.
  - Sites:
    - `src/frontend/App.tsx`: 3 site(s).
    - `src/frontend/Todos.tsx`: 1 site(s).
    - `src/routes/api.sync.ts`: 1 site(s).
    - `src/transport/result.server.ts`: 5 site(s).

- **src/frontend/App.tsx#errorText**
  - `error`: `unknown`. From a form action failure; why: pick the shown message.
  - Sites:
    - `src/frontend/App.tsx`: 2 site(s).

- **src/frontend/ui/classes.ts#cn**
  - `inputs`: `ClassValue[]`. From view class values; why: merge only these styles.
  - Sites:
    - `src/frontend/ui/button.tsx`: 1 site(s).
    - `src/frontend/ui/card.tsx`: 7 site(s).
    - `src/frontend/ui/input.tsx`: 1 site(s).

- **src/scaffold/backend/result.server.ts#readResult**
  - `result`: `RunResult<T>`. From a settled boundary call; why: return its value or raise its failure.
  - Sites:
    - `src/routes/api.auth.$.ts`: 2 site(s).
    - `src/routes/api.sync.ts`: 1 site(s).
    - `src/routes/api.telemetry.ts`: 1 site(s).
    - `src/scaffold/sync.functions.ts`: 2 site(s).
    - `src/transport/profile.functions.ts`: 1 site(s).
    - `src/transport/todos.functions.ts`: 1 site(s).

- **src/scaffold/backend/settings.server.ts#readSettings**
  - `env`: `Record<string, string | undefined>`. From the entry environment values; why: validate app settings once.
  - Sites:
    - `src/scaffold/frontend/router.tsx`: 1 site(s).
    - `src/server.ts`: 1 site(s).

- **src/scaffold/errors.ts#fail**
  - `kind`: `N`. From a failed scaffold action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Sites:
    - `src/scaffold/errors.ts`: 1 site(s).
    - `src/scaffold/frontend/sync.ts`: 3 site(s).

- **src/scaffold/errors.ts#raise**
  - `kind`: `N`. From a failed scaffold action; why: choose the managed error.
  - `payload`: `Errors.Payloads[N]`. From that action; why: keep its failure facts.
  - Sites:
    - `src/scaffold/backend/events.ts`: 3 site(s).
    - `src/scaffold/backend/notifications.ts`: 1 site(s).
    - `src/scaffold/backend/result.server.ts`: 1 site(s).
    - `src/scaffold/backend/settings.server.ts`: 2 site(s).
    - `src/scaffold/backend/stream.ts`: 2 site(s).
    - `src/scaffold/frontend/sync.ts`: 4 site(s).
    - `src/scaffold/start.ts`: 1 site(s).

- **src/scaffold/sync.ts#readExecution**
  - `raw`: `unknown`. From a mutation request; why: validate its execution ID.
  - Sites:
    - `src/backend/counter.ts`: 1 site(s).
    - `src/backend/profile.ts`: 1 site(s).
    - `src/transport/counter.functions.ts`: 1 site(s).

- **src/scaffold/sync.ts#readRetry**
  - `raw`: `unknown`. From a retry request; why: validate both execution IDs.
  - Sites:
    - `src/backend/profile.ts`: 1 site(s).
    - `src/transport/profile.functions.ts`: 1 site(s).

- **src/scaffold/telemetry/records.ts#encodeValue**
  - `value`: `unknown`. From a span or log attribute; why: bound and safely encode its wire value.
  - Sites:
    - `src/scaffold/telemetry/index.ts`: 1 site(s).
    - `src/scaffold/telemetry/records.ts`: 1 site(s).

- **src/scaffold/telemetry/records.ts#encodeFields**
  - `attributes`: `Record<string, unknown>`. From span or event attributes; why: bound each wire field.
  - Sites:
    - `src/scaffold/telemetry/index.ts`: 2 site(s).

- **src/scaffold/telemetry/records.ts#encodeNanos**
  - `time`: `number`. From a span or event epoch time; why: change milliseconds to wire nanoseconds.
  - Sites:
    - `src/scaffold/telemetry/index.ts`: 3 site(s).

- **src/transport/result.server.ts#readReceipt**
  - `result`: `RunResult<{ executionId: string }>`. From a settled mutation; why: turn its result into a network receipt.
  - Sites:
    - `src/transport/counter.functions.ts`: 1 site(s).
    - `src/transport/profile.functions.ts`: 2 site(s).
    - `src/transport/todos.functions.ts`: 1 site(s).
