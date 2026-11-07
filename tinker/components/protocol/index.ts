export * from "./middleware";
// remoteData still runs on middleware (`use`); rpc runs on the lifecycle's hooks. `Entry` is the
// lifecycle's here: a key's `implement` entry takes hooks, not a `use` list.
export { hook, lifecycle } from "./lifecycle";

export type {
  Context,
  Entry,
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
