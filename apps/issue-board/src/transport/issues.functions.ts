import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

import { startRequests } from "~/components/requests";
import { readResult } from "~/components/requests/index.server";

import { changeIssue, listTeamMembers } from "@/backend/issues.server";
import { teamInput } from "@/contracts/board";
import { issueCommand } from "@/contracts/issues";

import { readReceipt } from "./result.server";

export const getTeamMembers = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .validator(teamInput)
  .handler(async ({ context, data }) => {
    setResponseHeader("Cache-Control", "no-store");

    return readResult(
      await context.session.settle(listTeamMembers, { input: data, signal: context.signal }),
    );
  });

export const updateIssue = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(issueCommand)
  .handler(async ({ context, data }) =>
    readReceipt(await context.session.settle(changeIssue, { input: data, signal: context.signal })),
  );
