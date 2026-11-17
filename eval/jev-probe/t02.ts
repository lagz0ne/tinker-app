import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

const { hook } = transport;

// The server's work for `issueApi`, and the two hooks that guard the board. `signedIn` binds the
// caller from the message's meta; every op reads it. A call checks the team first and writes last.

/** The caller, bound by `signedIn` for the call's whole trace. */
const who = tag<string>({ label: "issues.who" });

/** Binds the caller from `meta.who`, or refuses: no one is anonymous here. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: (_, { input }) => {
    const name = input.meta.who;
    return name ? { tags: [who(name)] } : input.refuse({ signIn: true });
  },
});

/** A read of a team's part goes to its members only; the part names its team. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { who: who.required, list: members.controller },
  run: ({ who, list }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (teamId === undefined) return undefined;
    return list.of({ teamId, userId: who }).get() ? undefined : input.refuse({ notMember: teamId });
  },
});

/** Is the caller in this team? Each call asks first, so a stranger learns only `gone`. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { who: who.required, list: members.controller },
  run: ({ who, list }, { input }) =>
    list.of({ teamId: input.teamId, userId: who }).get() !== undefined,
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { who: who.required, list: members.controller },
  run: ({ who, list }, { input }) => {
    const { teamId } = input;
    if (list.where({ teamId }).get().length > 0) return { kind: "exists" as const };
    list.set({ teamId, userId: who });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { inTeam, list: members.controller },
  run: ({ inTeam, list }, { input }) => {
    const { teamId, userId } = input;
    if (!inTeam.run({ input: { teamId } })) return { kind: "gone" as const };
    list.set({ teamId, userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { inTeam, list: issues.controller },
  run: ({ inTeam, list }, { input, random }) => {
    const { teamId, title } = input;
    if (!inTeam.run({ input: { teamId } })) return { kind: "gone" as const };
    const number = list.where({ teamId }).get().length + 1;
    list.set({ teamId, id: random.uuid(), number, title, state: "backlog", version: 1 });
    return { kind: "created" as const, number };
  },
});

const moveIssue = operation({
  label: "issue.move.do",
  input: issueApi["issue.move"].input,
  depends: { inTeam, list: issues.controller },
  run: ({ inTeam, list }, { input }) => {
    const { teamId, id, version, state } = input;
    if (!inTeam.run({ input: { teamId } })) return { kind: "gone" as const };

    const issue = list.of({ teamId, id }).get();
    if (!issue) return { kind: "gone" as const };
    if (issue.version !== version) return { kind: "stale" as const, version: issue.version };

    list.set({ ...issue, state, version: version + 1 });
    return { kind: "moved" as const, version: version + 1 };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: { who: who.required, inTeam, issues: issues.controller, list: comments.controller },
  run: ({ who, inTeam, issues, list }, { input, random }) => {
    const { teamId, issueId, text } = input;
    if (!inTeam.run({ input: { teamId } })) return { kind: "gone" as const };
    if (!issues.of({ teamId, id: issueId }).get()) return { kind: "gone" as const };
    list.set({ teamId, issueId, id: random.uuid(), author: who, text });
    return { kind: "added" as const };
  },
});

/** The server's side of `issueApi`, by address: `issues.api({ implement: issueOps })`. */
export const issueOps = {
  "team.create": createTeam,
  "team.add": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "comment.add": addComment,
} as const;
