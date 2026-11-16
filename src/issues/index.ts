import { capsule } from "@tinkered/core";

import { issueApi, issueBoard } from "./contract";

/**
 * The issue board's capsule. Others import a file of the feature by its own path (ADR 0160).
 * - `board`: members, issues and comments (remote data, keyed by team). Members read their team.
 * - `api`: every change, as a call (rpc).
 */
export const issues = capsule({ label: "issues", exports: { board: issueBoard, api: issueApi } });
