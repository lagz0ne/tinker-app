import { data, remoteData, rpc } from "@tinkered/core";
import { z } from "zod";

// The issue board's contract: both sides import it. A team's issues move through four states,
// live on every member's tab. A team can be archived: it keeps its issues and takes no change. Rebuilt from the Start-era board
// (tinker-app tag `start-archive`) on keyed data. Every key starts with `teamId`, so one guard
// checks every part. Every cell is served: a cell that is not served is a copy per session, so a
// call's write to it would end with the call.

export const states = ["backlog", "todo", "doing", "done"] as const;

const member = z.object({ teamId: z.string(), userId: z.string() });

const issue = z.object({
  teamId: z.string(),
  id: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(states),
  version: z.number(),
});

export type Issue = z.infer<typeof issue>;

/** Who is in which team. A team is its first member: `ENG` exists once someone made it. */
export const members = data({
  label: "issues.members",
  mode: "keyed",
  parse: member,
  key: (m) => ({ teamId: m.teamId, userId: m.userId }),
});

/** The issues, by team: a tab reads one team with `where({ teamId })`. */
export const issues = data({
  label: "issues.list",
  mode: "keyed",
  parse: issue,
  key: (i) => ({ teamId: i.teamId, id: i.id }),
});

/** The archived teams: a team is archived once it has a member here. */
export const archived = data({
  label: "issues.archived",
  mode: "keyed",
  parse: z.object({ teamId: z.string() }),
  key: (a) => ({ teamId: a.teamId }),
});

/** Read: each part goes only to the members of its team. */
export const issueBoard = remoteData({ members, issues, archived });

const team = z.object({ teamId: z.string() });
const gone = z.object({ kind: z.literal("gone") });
/** The answer of every change to an archived team: nothing changed. */
const shut = z.object({ kind: z.literal("archived") });

/** Ask: every change is a call; the server is the only writer. Outcomes are output. */
export const issueApi = rpc({
  "team.create": {
    input: z.object({
      teamId: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z][A-Z0-9]{1,9}$/),
    }),
    /** The key as the server keeps it: the page opens the team there, never at its own copy. */
    output: z.object({ kind: z.enum(["created", "exists"]), teamId: z.string() }),
  },
  "team.add": {
    input: team.extend({ userId: z.string().trim().min(1) }),
    output: z.discriminatedUnion("kind", [z.object({ kind: z.literal("added") }), gone, shut]),
  },
  "issue.create": {
    input: team.extend({ title: z.string().trim().min(1).max(200) }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("created"), number: z.number() }),
      gone,
      shut,
    ]),
  },
  /** A move names the version it saw: a newer one answers `stale`, so no edit is lost. */
  "issue.move": {
    input: team.extend({ id: z.string(), version: z.number(), state: z.enum(states) }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("moved"), version: z.number() }),
      z.object({ kind: z.literal("stale"), version: z.number() }),
      gone,
      shut,
    ]),
  },
  /** A rename names the version it saw, as a move does: a newer one answers `stale`. */
  "issue.rename": {
    input: team.extend({
      id: z.string(),
      version: z.number(),
      title: z.string().trim().min(1).max(200),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("renamed"), version: z.number() }),
      z.object({ kind: z.literal("stale"), version: z.number() }),
      gone,
      shut,
    ]),
  },
  /** Archive a team: its members still read it, and every change answers `archived`. */
  "team.archive": {
    input: team,
    output: z.discriminatedUnion("kind", [shut, gone]),
  },
});
