import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";

import { startRequests } from "~/components/requests";
import { cancelledCall } from "~/components/requests/index.server";

import { changeIssue, listTeamMembers } from "@/backend/issues.server";
import { teamInput } from "@/contracts/board";
import { issueCommand } from "@/contracts/issues";

import { readReceipt } from "./result.server";

export const getTeamMembers = createServerFn({ method: "GET" })
  .middleware([startRequests.middleware])
  .validator(teamInput)
  .handler(async ({ context, data }) => {
    setResponseHeader("Cache-Control", "no-store");

    const result = await context.session.settle(listTeamMembers, {
      input: data,
      signal: context.signal,
    });
    if (result.status === "failed") throw result.error;
    if (result.status === "cancelled") return context.session.run(cancelledCall);
    return result.value;
  });

export const updateIssue = createServerFn({ method: "POST" })
  .middleware([startRequests.middleware])
  .validator(issueCommand)
  .handler(async ({ context, data }) =>
    readReceipt(
      await context.session.settle(changeIssue, {
        input: data,
        signal: context.signal,
      }),
    ),
  );
