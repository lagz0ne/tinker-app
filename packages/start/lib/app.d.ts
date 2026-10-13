import type { Data, Many, Operation, Resource, Scope, Tag } from "@tinker/core";

import type { Env as Environment } from "../src/env";
import type { Database as Store } from "../src/parts/sync/database";
import type { Sync } from "../src/parts/sync/envelopes";

/** The generated seam checks these roles without widening their inferred types. */
export declare namespace App {
  type Env = Environment.Values;
  type Bindings = Tag.Bindings;
  type Extensions = Many<Scope.Extension<unknown>>;
  type Settings = Environment.Read;
  type Database = Resource.Handle<Store.Handle | PromiseLike<Store.Handle>>;
  type Auth = Resource.Handle<AuthPort | PromiseLike<AuthPort>>;
  type ReadAccount = Operation.Handle<string | null | PromiseLike<string | null>, void>;
  type Bootstrap = Operation.Handle<Sync.Snapshot | PromiseLike<Sync.Snapshot>, void>;
  type Records = Resource.Handle<Sync.Records | PromiseLike<Sync.Records>>;
  type ReadBatch = Data.Parse<{ version: number; events: Sync.Event[] }>;
  type ReadBootstrap = Data.Parse<{ version: number; snapshot: Sync.Snapshot }>;
  type ReadSnapshot = Data.Parse<Sync.Snapshot>;
  type StreamMessage = Data.Parse<
    { kind: "changes"; events: Sync.Event[] } | { kind: "account-change" }
  >;
}

/** The auth part reads only these methods from an item's default export. */
interface AuthPort {
  handler(request: Request): Response | Promise<Response>;
  api: {
    getSession(options: {
      headers: Headers;
      query?: { disableCookieCache: boolean; disableRefresh: boolean };
    }): Promise<{ user: { id: string } } | null>;
  };
}
