import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { readExecution } from "~/components/sync";

import { incrementCounter } from "@/demo/backend/counter.server";

import { readReceipt } from "./result.server";

export const updateCounter = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readExecution)
  .handler(async ({ context, data }) =>
    context.session.run(readReceipt, {
      input: await context.session.settle(incrementCounter, {
        input: data,
        signal: context.signal,
      }),
    }),
  );
