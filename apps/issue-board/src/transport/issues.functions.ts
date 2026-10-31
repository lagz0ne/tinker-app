import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

import { startRequests } from "~/components/requests";

import { teamInput } from "@/contracts/board";
import { issueCommand } from "@/contracts/issues";

import { issueReceipt, teamMembersRead } from "./result.server";

export const getTeamMembers = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .validator(teamInput)
  .handler(async ({ context, data }) => {
    setResponseHeader("Cache-Control", "no-store");

    return context.session.run(teamMembersRead, { input: data });
  });

export const updateIssue = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(issueCommand)
  .handler(async ({ context, data }) => context.session.run(issueReceipt, { input: data }));
