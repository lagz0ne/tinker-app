import { tag } from "@tinker/core";
import type { Operation, Resource } from "@tinker/core";

import type { Database } from "./parts/sync/database";
import type { Sync } from "./parts/sync/envelopes";

/** The main supplies descriptors; each request resolves them in its own scope. */
export declare namespace ServerParts {
  type Auth = {
    handler(request: Request): Promise<Response>;
    api: {
      getSession(options: {
        headers: Headers;
        query?: { disableCookieCache: boolean; disableRefresh: boolean };
      }): Promise<{ user: { id: string } } | null>;
    };
  };
  type Bindings = {
    auth: Resource.Handle<Auth | Promise<Auth>>;
    database: Resource.Handle<Database.Handle | Promise<Database.Handle>>;
    bootstrap: Operation.Handle<Sync.Snapshot | Promise<Sync.Snapshot>, void>;
    readAccount: Operation.Handle<string | null | Promise<string | null>, void>;
  };
}

export const serverParts = tag<ServerParts.Bindings>({ label: "start.serverParts" });
