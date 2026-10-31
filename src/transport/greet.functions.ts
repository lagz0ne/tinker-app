import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";

import { greetRead } from "./greet.server";

export const runGreet = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .handler(async ({ context }) => context.session.run(greetRead));
