export const extensions = [];
export { records } from "../frontend/records.ts";
export { readBatch, readBootstrap, readSnapshot, streamMessage } from "../contracts/sync.ts";
import type { FeatureSync } from "../contracts/sync.ts";
/** This app fills the base's open registry with its own bodies. */
declare module "@tinker/start" {
  interface Register {
    change: FeatureSync.Change;
    result: FeatureSync.Result;
    public: FeatureSync.Public;
    private: FeatureSync.Private;
  }
}
