import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

// The server's work for `issueApi`, and the two guards. A guard binds the caller as `viewer`, so
// each op reads who is asking from the call itself, never from its input.

const viewer = tag<string>({ label: "issues.viewer" });

/** The start hook on calls and reads: no `who` in the meta ends the call; else it binds `viewer`. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  run: (_, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [viewer(who)] } : input.refuse({ signIn: true });
  },
});

/** The start hook on reads: a part goes only to a member of its team. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId ?? "";
    return list.of({ teamId, userId: me }).get() ? undefined : input.refuse({ notMember: teamId });
  },
});

/** The member check each call runs: is the caller in this team. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) =>
    list.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

const gone = { kind: "gone" as const };

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) => {
    const { teamId } = input;
    if (list.where({ teamId }).get().length > 0) return { kind: "exists" as const };
    list.set({ teamId, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { inTeam, list: members.controller },
  run: ({ inTeam, list }, { input }) => {
    const { teamId, userId } = input;
    if (!inTeam.run({ input: { teamId } })) return gone;
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
    if (!inTeam.run({ input: { teamId } })) return gone;
    const number = list.where({ teamId }).get().length + 1;
    list.set({
      teamId,
      id: random.uuid(),
      number,
      title,
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
    const { teamId, id, version, state } = input;
    if (!inTeam.run({ input: { teamId } })) return gone;

    const issue = list.of({ teamId, id }).get();
    if (!issue) return gone;

    if (issue.version !== version) return { kind: "stale" as const, version: issue.version };

    list.set({ ...issue, state, version: version + 1 });
    return { kind: "moved" as const, version: version + 1 };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: { me: viewer.required, inTeam, list: issues.controller, thread: comments.controller },
  run: ({ me, inTeam, list, thread }, { input, random }) => {
    const { teamId, issueId, text } = input;
    if (!inTeam.run({ input: { teamId } })) return gone;
    if (!list.of({ teamId, id: issueId }).get()) return gone;
    thread.set({ teamId, issueId, id: random.uuid(), author: me, text });
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
