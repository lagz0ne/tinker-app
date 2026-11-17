import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

// The server's work for `issueApi`, and the two guards. Each op writes one member; `issueBoard`
// tells every tab that reads its part. A guard binds the caller (`viewer`) for the ops after it.

/** Who made the call: `signedIn` binds it from the message's meta. */
const viewer = tag<string>({ label: "issues.viewer" });

/** Start hook, calls and reads: no `who` in the meta, no entry. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  run: (_, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [viewer(who)] } : input.refuse({ signIn: true });
  },
});

/** Start hook, reads only: a part goes to the members of its team. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { me: viewer.required, list: members.controller },
  run: ({ me, list }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (teamId === undefined || list.of({ teamId, userId: me }).get()) return undefined;
    return input.refuse({ notMember: teamId });
  },
});

/** The member check each call runs: is the caller in the team it names? */
const inTeam = operation({
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
  depends: {
    inTeam,
    me: viewer.required,
    list: comments.controller,
    issueList: issues.controller,
  },
  run: ({ inTeam, me, list, issueList }, { input, random }) => {
    const { teamId, issueId, text } = input;
    if (!inTeam.run({ input: { teamId } })) return { kind: "gone" as const };
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
