import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { readExecution } from "~/components/sync";

import { counterReceipt } from "./result.server";

export const updateCounter = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(readExecution)
  .handler(async ({ context, data }) => context.session.run(counterReceipt, { input: data }));
