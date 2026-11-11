import { data, remoteData, rpc } from "@tinker/core";
import { z } from "zod";

// The issue board's contract: both sides import it. What can be read (`issueBoard`, remote data)
// and what can be asked (`issueApi`, rpc). Rebuilt from the Start-era board (tinker-app tag
// `start-archive`, slices 2 to 4) on keyed data: issues by team, comments by issue.

export const issueStates = ["backlog", "todo", "in_progress", "done"] as const;
export type IssueState = (typeof issueStates)[number];

const team = z.object({ teamId: z.string(), key: z.string(), name: z.string(), seq: z.number() });
export type Team = z.infer<typeof team>;

const member = z.object({ teamId: z.string(), userId: z.string() });

const issue = z.object({
  teamId: z.string(),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(issueStates),
  rank: z.number(),
  version: z.number(),
});

export type Issue = z.infer<typeof issue>;

const comment = z.object({
  teamId: z.string(),
  issueId: z.string(),
  id: z.string(),
  author: z.string(),
  text: z.string(),
  at: z.number(),
});

export type Comment = z.infer<typeof comment>;

// Every cell is served, so every cell lives at the server's root. A cell that is not served is a
// single cell's copy per session: a write from a call would land in the call's session and end
// with it. Each key starts with `teamId`, so one guard checks every part.

/** The teams, by id. `seq` is the last issue number, so ENG-1, ENG-2 never skip. */
export const teams = data({
  label: "issues.teams",
  mode: "keyed",
  parse: team,
  key: (t) => ({ teamId: t.teamId }),
});

/** Who is in which team: the guard reads it, and a member reads it for an assignee list. */
export const members = data({
  label: "issues.members",
  mode: "keyed",
  parse: member,
  key: (m) => ({ teamId: m.teamId, userId: m.userId }),
});

/** The issues, keyed by team and id: a tab reads one team with `where({ teamId })`. */
export const issues = data({
  label: "issues.list",
  mode: "keyed",
  parse: issue,
  key: (i) => ({ teamId: i.teamId, id: i.id }),
});

/**
 * The comments, keyed by team, issue and id: a tab reads one thread with
 * `where({ teamId, issueId })`. The team is in the key so the guard can check the part alone.
 */
export const comments = data({
  label: "issues.comments",
  mode: "keyed",
  parse: comment,
  key: (c) => ({ teamId: c.teamId, issueId: c.issueId, id: c.id }),
});

/** Read: the server serves every cell by part, and only to the members of the part's team. */
export const issueBoard = remoteData({ teams, members, issues, comments });

const gone = z.object({ kind: z.literal("gone") });

/** Ask: every change is a call; the server is the only writer. Outcomes are output. */
export const issueApi = rpc({
  "team.create": {
    input: z.object({
      key: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9]{1,9}$/),
      name: z.string().trim().min(1),
    }),
    output: z.object({ id: z.string() }),
  },
  "team.addMember": {
    input: z.object({ teamId: z.string(), userId: z.string().min(1) }),
    output: z.discriminatedUnion("kind", [z.object({ kind: z.literal("added") }), gone]),
  },
  "issue.create": {
    input: z.object({
      teamId: z.string(),
      title: z.string().trim().min(1).max(200),
      state: z.enum(issueStates),
    }),
    output: z.object({ id: z.string(), number: z.number() }),
  },
  "issue.move": {
    input: z.object({
      teamId: z.string(),
      id: z.string(),
      version: z.number(),
      state: z.enum(issueStates),
      beforeId: z.string().nullable(),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("moved"), version: z.number() }),
      z.object({ kind: z.literal("stale"), version: z.number() }),
      gone,
    ]),
  },
  "comment.add": {
    input: z.object({
      teamId: z.string(),
      issueId: z.string(),
      text: z.string().trim().min(1).max(5000),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("added"), id: z.string() }),
      gone,
    ]),
  },
});
