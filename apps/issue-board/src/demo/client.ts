export { readProfileCommand, readTodoCommand } from "@/demo/contracts/commands";

export { credentials } from "@/demo/contracts/credentials";

export { readProfileInput } from "@/demo/contracts/profile-contract";

export type { Profile } from "@/demo/contracts/profile-contract";

export { readTodoChange } from "@/demo/contracts/todos-contract";

export type { Todos } from "@/demo/contracts/todos-contract";

export { readFeatureEvents, readFeatureResult } from "@/demo/contracts/sync";

export type { FeatureSync } from "@/demo/contracts/sync";

export {
  profile,
  nameDraft,
  pending,
  notice,
  authMode,
  todos,
  counter,
  profileResult,
} from "@/demo/frontend/state";

export { isError, raise } from "./errors";

export type { Errors } from "./errors";

export { records } from "@/demo/frontend/records";

export { readBatch, readBootstrap, readSnapshot, streamMessage } from "@/demo/contracts/sync";

import type { FeatureSync } from "@/demo/contracts/sync";

/** This app fills the base's open registry with its own bodies. */
declare module "~/components/sync" {
  interface Register {
    change: FeatureSync.Change;
    result: FeatureSync.Result;
    public: FeatureSync.Public;
    private: FeatureSync.Private;
  }
}
