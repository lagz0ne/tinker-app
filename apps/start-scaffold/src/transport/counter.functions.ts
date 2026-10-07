import { createServerFn } from "@tanstack/react-start";
import { incrementCounter } from "../backend/index.ts";
import { readExecution } from "../contracts/sync.ts";
import { startRequests } from "@tinker/start";
import { readReceipt } from "./result.server.ts";
export const updateCounter = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readExecution)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(incrementCounter, { input: data, signal: context.signal }),
    ),
  );
