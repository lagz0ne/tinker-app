import { createServerFn } from "@tanstack/react-start";
import { incrementCounter } from "../backend/index.ts";
import { readExecution } from "../contracts/sync.ts";
import { startRequests } from "../scaffold/start.ts";
import { readReceipt } from "../scaffold/backend/result.server.ts";
export const updateCounter = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .inputValidator(readExecution)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(incrementCounter, { input: data, signal: context.signal }),
    ),
  );
