import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { cancelledCall } from "~/components/requests/index.server";

import { greet } from "@/backend/greet";

export const runGreet = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => {
    const result = await context.session.settle(greet, {
      input: { name: "world" },
      signal: context.signal,
    });
    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return context.session.run(cancelledCall);
    return result.value;
  });
