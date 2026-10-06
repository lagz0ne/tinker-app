import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { bootstrap, readAccount } from "#tinker/app.server";
import { readResult } from "../../backend/result.server.ts";
import { startRequests } from "../../start.ts";

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
