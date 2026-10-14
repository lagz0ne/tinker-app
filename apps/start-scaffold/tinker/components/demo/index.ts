export { readProfileCommand, readTodoCommand } from "~/components/demo/contracts/commands";

export { credentials } from "~/components/demo/contracts/credentials";

export { readProfileInput } from "~/components/demo/contracts/profile-contract";

export type { Profile } from "~/components/demo/contracts/profile-contract";

export { readTodoChange } from "~/components/demo/contracts/todos-contract";

export type { Todos } from "~/components/demo/contracts/todos-contract";

export {
  readExecution,
  readCursor,
  readPrivateCursor,
  readRetry,
  readFeatureEvents,
  readFeatureResult,
} from "~/components/demo/contracts/sync";

export type { Sync, FeatureSync } from "~/components/demo/contracts/sync";

export {
  profile,
  nameDraft,
  pending,
  notice,
  authMode,
  todos,
  counter,
  profileResult,
} from "~/components/demo/frontend/state";

export { isError, raise } from "./errors";

export type { Errors } from "./errors";

export { records } from "~/components/demo/frontend/records";

export {
  readBatch,
  readBootstrap,
  readSnapshot,
  streamMessage,
} from "~/components/demo/contracts/sync";

import type { FeatureSync } from "~/components/demo/contracts/sync";

/** This app fills the base's open registry with its own bodies. */
declare module "@tinker/start" {
  interface Register {
    change: FeatureSync.Change;
    result: FeatureSync.Result;
    public: FeatureSync.Public;
    private: FeatureSync.Private;
  }
}
