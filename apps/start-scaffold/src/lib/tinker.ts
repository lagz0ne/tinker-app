export { records } from "../frontend/records.ts";
export { readBatch, readBootstrap, readSnapshot, readStreamMessage } from "../contracts/sync.ts";
import type { FeatureSync } from "../contracts/sync.ts";
/** This app fills the scaffold's open registry with its own bodies. */
declare module "../scaffold/sync.ts" {
  interface Register {
    change: FeatureSync.Change;
    result: FeatureSync.Result;
    public: FeatureSync.Public;
    private: FeatureSync.Private;
  }
}
