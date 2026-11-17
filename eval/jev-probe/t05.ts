import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

// The server's work for `issueApi`, and the two guards. Every op writes through the keyed cells;
// `issueBoard` tells each tab that reads a part. The caller is the `who` the guard bound.

/** Who is calling: bound by `signedIn` for the later guards and for the op. */
const viewer = tag<string>({ label: "issues.viewer" });

/** Start hook, on calls and reads: no `who` in the meta ends the message. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  run: (_, { input }) => {
    const who = input.meta.who;
    return typeof who === "string" && who
      ? { tags: [viewer(who)] }
      : input.refuse({ signIn: true });
  },
});

/** Start hook, on reads: a part of a team goes only to the team's members. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (teamId !== undefined && !list.of({ teamId, userId: me }).get()) {
      return input.refuse({ notMember: teamId });
    }
    return undefined;
  },
});

/** The member check each call runs: is the caller in this team? */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) =>
    list.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

const gone = { kind: "gone" } as const;

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) => {
    if (list.where({ teamId: input.teamId }).get().length > 0) return { kind: "exists" as const };
    list.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { inTeam, list: members.controller },
  run: ({ inTeam, list }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return gone;
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { inTeam, list: issues.controller },
  run: ({ inTeam, list }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return gone;
    const number = list.where({ teamId: input.teamId }).get().length + 1;
    list.set({
      teamId: input.teamId,
      id: random.uuid(),
      number,
      title: input.title,
      state: "backlog",
      version: 1,
    });
    return { kind: "created" as const, number };
  },
});

const moveIssue = operation({
  label: "issue.move.do",
  input: issueApi["issue.move"].input,
  depends: { inTeam, list: issues.controller },
  run: ({ inTeam, list }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return gone;

    const issue = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!issue) return gone;
    if (issue.version !== input.version) return { kind: "stale" as const, version: issue.version };

    const version = issue.version + 1;
    list.set({ ...issue, state: input.state, version });
    return { kind: "moved" as const, version };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: { me: viewer.required, inTeam, list: issues.controller, thread: comments.controller },
  run: ({ me, inTeam, list, thread }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return gone;
    if (!list.of({ teamId: input.teamId, id: input.issueId }).get()) return gone;
    const id = String(
      thread.where({ teamId: input.teamId, issueId: input.issueId }).get().length + 1,
    );
    thread.set({
      teamId: input.teamId,
      issueId: input.issueId,
      id,
      author: me,
      text: input.text,
    });
    return { kind: "added" as const };
  },
});

/** The server's side of `issueApi`, by address: `issueApi({ implement: issueOps })`. */
export const issueOps = {
  "team.create": createTeam,
  "team.add": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "comment.add": addComment,
} as const;
