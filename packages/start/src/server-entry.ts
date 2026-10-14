import type { Observe, Scope } from "@tinker/core";

/** The app entry retains both roots; Start borrows context and observation. */
export declare namespace ServerEntry {
  type Next = (request: Request) => Promise<Response>;
  type Handle = {
    requestContext: { scope: Scope.Handle };
    renderObserve: Observe.Config;
    close(): Promise<void>;
    fetch?(request: Request, next: Next): Promise<Response> | Response;
  };
}
