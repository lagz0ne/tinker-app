# Plain functions

This list is checked against src.
Callers include direct calls and typed callback registrations.
Repeated calls by one caller count once; self-calls do not count.
Tests and generated files do not count.

- **src/contracts/commands.ts#readProfileCommand**
  - `raw`: `unknown`. From the profile request body; why: read its execution ID and profile input.
  - Callers:
    - `src/backend/profile.server.ts#saveProfile.input`
    - `src/transport/profile.functions.ts#module`

- **src/contracts/commands.ts#readTodoCommand**
  - `raw`: `unknown`. From the todo request body; why: read its execution ID and todo change.
  - Callers:
    - `src/backend/todos.server.ts#changeTodo.input`
    - `src/transport/todos.functions.ts#module`

- **src/contracts/profile.ts#readProfileInput**
  - `raw`: `unknown`. From the profile command or draft; why: validate only the saved name.
  - Callers:
    - `src/contracts/commands.ts#readProfileCommand`
    - `src/frontend/profile-actions.ts#saveName.input`

- **src/contracts/sync.ts#readFeatureEvent**
  - `raw`: `unknown`. From a saved event row; why: validate its feature body before replay.
  - Callers:
    - `src/backend/sync.server.ts#replayPrivate.run`
    - `src/backend/sync.server.ts#replayPublic.run`

- **src/contracts/todos.ts#readTodoChange**
  - `raw`: `unknown`. From the todo command or form; why: validate one todo change.
  - Callers:
    - `src/contracts/commands.ts#readTodoCommand`
    - `src/frontend/Todos.tsx#saveTodo.input`

- **src/errors.ts#raise**
  - `kind`: `N`. From the failing caller; why: choose the managed error.
  - `payload`: `Errors.Payload<N>`. From the failing caller; why: keep facts for that error.
  - Callers:
    - `src/backend/auth.server.ts#currentUser.factory`
    - `src/backend/counter.server.ts#incrementCounter.run.callback1`
    - `src/backend/database.server.ts#databaseSettings.factory`
    - `src/backend/mail.server.ts#mailSettings.factory`
    - `src/backend/profile.server.ts#notifyProfile.run`
    - `src/backend/profile.server.ts#retryNotification.run.callback1`
    - `src/backend/profile.server.ts#saveProfile.run.callback1`
    - `src/backend/sync.server.ts#bootstrapPrivate.run.callback1`
    - `src/backend/sync.server.ts#replayPrivate.run`
    - `src/backend/todos.server.ts#changeTodo.run.callback1`
    - `src/contracts/profile.ts#readProfileInput`
    - `src/contracts/todos.ts#readTodoChange`
    - `src/frontend/auth-actions.ts#signIn.input`
    - `src/frontend/auth-actions.ts#signIn.run`
    - `src/frontend/auth-actions.ts#signOut.run`
    - `src/frontend/profile-actions.ts#saveName.run`
    - `src/transport/result.server.ts#readReceipt`

- **src/errors.ts#isError**
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
