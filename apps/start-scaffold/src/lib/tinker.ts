export const extensions = [];
export { records } from "../frontend/records";
export { readBatch, readBootstrap, readSnapshot, streamMessage } from "../contracts/sync";
import type { FeatureSync } from "../contracts/sync";

/** This app fills the base's open registry with its own bodies. */
declare module "@tinker/start" {
  interface Register {
    change: FeatureSync.Change;
    result: FeatureSync.Result;
    public: FeatureSync.Public;
    private: FeatureSync.Private;
  }
}
