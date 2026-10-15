import type { RunResult } from "@tinker/core";

import { isError, raise } from "@/demo/client";

const rejections = [
  ["TeamChanged", "Team membership changed. Try again."],
  ["IssueConflict", "This issue changed. Close this edit and open it again."],
  ["InvalidPosition", "That position changed. Try the move again."],
  ["IssueMissing", "That issue is not in this team."],
  ["InvalidAssignee", "Choose a member of this team."],
  ["SignInRequired", "Sign in to change private records."],
  ["NotTeamMember", "You are not on that team."],
  ["TeamAdminRequired", "Only a team admin can add members."],
  ["TeamKeyTaken", "That team key is taken."],
  ["UserNotFound", "That email needs an account first."],
  ["TodoMissing", "That todo is not in your list."],
  ["RetryNotAvailable", "There is no failed notification to retry."],
  ["StreamDenied", "That execution is not in your stream."],
] as const;

/**
 * @param result - From a settled mutation; why: turn its result into a network receipt.
 */
export function readReceipt(result: RunResult<{ executionId: string }>) {
  if (result.status === "success") {
    return { kind: "accepted" as const, executionId: result.value.executionId };
  }

  if (result.status === "cancelled") raise("Cancelled", {});

  const error = result.error;
  if (isError(error, "BadInput")) {
    return { kind: "rejected" as const, message: error.payload.reason };
  }
  const refusal = rejections.find(([kind]) => isError(error, kind));
  if (refusal) return { kind: "rejected" as const, message: refusal[1] };

  throw error;
}
