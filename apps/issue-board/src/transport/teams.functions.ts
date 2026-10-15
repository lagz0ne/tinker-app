import { createServerFn } from "@tanstack/react-start";

import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";

import { changeTeam, readTeam } from "@/backend/teams.server";
import { teamCommand, teamInput } from "@/contracts/board";

import { readReceipt } from "./result.server";

export const getTeam = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .validator(teamInput)
  .handler(async ({ context, data }) =>
    readResult(await context.session.settle(readTeam, { input: data, signal: context.signal })),
  );

export const updateTeam = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(teamCommand)
  .handler(async ({ context, data }) =>
    readReceipt(await context.session.settle(changeTeam, { input: data, signal: context.signal })),
  );
