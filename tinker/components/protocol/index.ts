export * from "./middleware";
// remoteData still runs on middleware (`use`); rpc runs on the lifecycle's hooks. The names both
// files carry (`Meta`, `Tags`, `Entry`) are the middleware's here; rpc takes its own below.
export { hook, lifecycle } from "./lifecycle";

export type {
  Context,
  Hooks,
  OnError,
  OnFinish,
  OnStart,
  OnSuccess,
  Outcome,
  RunOptions,
} from "./lifecycle";

export * from "./protocol";
export * from "./wire";
