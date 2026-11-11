import { capsule } from "@tinker/core";

import { issueApi, issueBoard } from "./contract";

export type { Comment, Issue, IssueState } from "./contract";
export { issueStates } from "./contract";

/**
 * The issue board's one door: other features and the cmds import `@/issues` only.
 * - `board`: issues by team, comments by issue (remote data, keyed). Members only.
 * - `api`: every change, as a call (rpc).
 */
export const issues = capsule({ label: "issues", exports: { board: issueBoard, api: issueApi } });
