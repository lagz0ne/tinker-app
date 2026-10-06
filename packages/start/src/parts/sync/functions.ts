import { createServerFn } from "@tanstack/react-start";
import { resource } from "@tinker/core";
import { setResponseHeader } from "@tanstack/react-start/server";
import { bootstrap, readAccount } from "#tinker/app.server";
import { readResult } from "../../backend/result.server.ts";
import { startRequests } from "../../start.ts";
import type { Sync } from "./envelopes.ts";

/** The app's snapshot for this request's account: what a tab loads before it streams. */
export const getBootstrap = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    setResponseHeader("Cache-Control", "no-store");
    return readResult(await context.session.settle(bootstrap, { signal: context.signal }));
  });

/** The account this request signs in as, or null: what a tab checks before it trusts a page. */
export const getAccount = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    setResponseHeader("Cache-Control", "no-store");
    return readResult(await context.session.settle(readAccount, { signal: context.signal }));
  });

/**
 * The tab's network client: the two server functions above. Only scope tests replace it. This file
 * is Start glue (a server function runs only inside Start), so the build proves it, not a test.
 */
export const snapshotSource = resource({
  label: "sync.snapshotSource",
  factory: () => ({
    load: (options: { signal: AbortSignal }): Promise<Sync.Snapshot> => getBootstrap(options),
    account: (options: { signal: AbortSignal }): Promise<string | null> => getAccount(options),
  }),
});
