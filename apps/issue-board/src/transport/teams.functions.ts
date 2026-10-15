import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";

import { changeTeam } from "@/backend/teams.server";
import { teamCommand } from "@/contracts/board";

import { readReceipt } from "./result.server";

export const updateTeam = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(teamCommand)
  .handler(async ({ context, data }) =>
    readReceipt(await context.session.settle(changeTeam, { input: data, signal: context.signal })),
  );
