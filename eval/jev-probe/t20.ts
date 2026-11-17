import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

// The server's work for `issueApi`, and the two guards. `signedIn` names the viewer from the
// message's `who`; every call then checks the team, and every read of a part checks it too. Each
// op writes members of the keyed cells; `issueBoard` tells each tab that reads them.

const viewer = tag<string>({ label: "issues.viewer" });

/** Start hook, calls and reads: a message with no `who` is refused; else its `who` is the viewer. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  run: (_, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [viewer(who)] } : input.refuse({ signIn: true });
  },
});

/** Start hook, reads: a part goes only to a member of its team. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId ?? "";
    return list.of({ teamId, userId: me }).get() ? undefined : input.refuse({ notMember: teamId });
  },
});

/** The member check each call runs: is the viewer in this team? */
export const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) =>
    list.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

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
    if (!inTeam.run({ input })) return { kind: "gone" as const };
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { inTeam, list: issues.controller },
  run: ({ inTeam, list }, { input, random }) => {
    if (!inTeam.run({ input })) return { kind: "gone" as const };

    const { teamId, title } = input;
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
    if (!inTeam.run({ input })) return { kind: "gone" as const };

    const issue = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!issue) return { kind: "gone" as const };
    if (issue.version !== input.version) return { kind: "stale" as const, version: issue.version };

    const version = issue.version + 1;
    list.set({ ...issue, state: input.state, version });
    return { kind: "moved" as const, version };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: { me: viewer.required, inTeam, issueList: issues.controller, list: comments.controller },
  run: ({ me, inTeam, issueList, list }, { input, random }) => {
    if (!inTeam.run({ input })) return { kind: "gone" as const };

    const { teamId, issueId, text } = input;
    if (!issueList.of({ teamId, id: issueId }).get()) return { kind: "gone" as const };

    list.set({ teamId, issueId, id: random.uuid(), author: me, text });
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
