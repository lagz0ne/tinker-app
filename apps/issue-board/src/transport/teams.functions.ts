import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";

import { teamCommand } from "@/contracts/board";

import { teamReceipt } from "./result.server";

export const updateTeam = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(teamCommand)
  .handler(async ({ context, data }) => context.session.run(teamReceipt, { input: data }));
