import { createServerFn } from "@tanstack/react-start";
import { startRequests } from "@tinker/start";
import { readResult } from "@tinker/start/server";
import { greet } from "../backend/greet";

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
