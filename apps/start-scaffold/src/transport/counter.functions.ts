import { createServerFn } from "@tanstack/react-start";
import { startRequests } from "@tinker/start";

import { readExecution } from "~/components/demo";
import { incrementCounter } from "~/components/demo/index.server";

import { readReceipt } from "./result.server";

export const updateCounter = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readExecution)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(incrementCounter, { input: data, signal: context.signal }),
    ),
  );
