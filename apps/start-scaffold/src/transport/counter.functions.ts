import { createServerFn } from "@tanstack/react-start";
import { incrementCounter } from "../backend/index.server";
import { readExecution } from "../contracts/sync";
import { startRequests } from "@tinker/start";
import { readReceipt } from "./result.server";

export const updateCounter = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readExecution)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(incrementCounter, { input: data, signal: context.signal }),
    ),
  );
