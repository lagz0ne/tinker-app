import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";

import { greet } from "@/backend/greet";

export const runGreet = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) =>
    readResult(
      await context.session.settle(greet, {
        input: { name: "world" },
        signal: context.signal,
      }),
    ),
  );
