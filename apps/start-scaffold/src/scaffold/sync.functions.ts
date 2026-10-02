import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { bootstrap, readAccount } from "../backend/index.ts";
import { startRequests } from "./start.ts";
import { readResult } from "./backend/result.server.ts";
export const getBootstrap = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    setResponseHeader("Cache-Control", "no-store");
    return readResult(await context.session.settle(bootstrap, { signal: context.signal }));
  });
export const getAccount = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    setResponseHeader("Cache-Control", "no-store");
    return readResult(await context.session.settle(readAccount, { signal: context.signal }));
  });
