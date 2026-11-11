import { capsule } from "@tinker/core";

import { issueApi, issueBoard } from "./contract";

export { Board, IssuesHome, Thread } from "./board";
export { signIn, whoMeta } from "./sign-in";

/**
 * The issue board's one door: other features and the cmds import `@/issues` only.
 * - `board`: members, issues and comments (remote data, keyed by team). Members read their team.
 * - `api`: every change, as a call (rpc).
 */
export const issues = capsule({ label: "issues", exports: { board: issueBoard, api: issueApi } });
