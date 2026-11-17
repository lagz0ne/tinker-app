import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issues, members } from "./contract";

// The server's work for `issueApi`, and the two hooks that guard it. `signedIn` binds the caller;
// each op asks `inTeam` first, so a caller outside the team gets `gone`, never a hint it exists.

/** The caller, bound by `signedIn` from the message's meta. */
const user = tag<string>({ label: "issues.user" });

/** Start hook on calls and reads: no `who` in the meta, no entry. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  run: (_, { input }) =>
    input.meta.who ? { tags: [user(input.meta.who)] } : input.refuse({ signIn: true }),
});

const named = z.object({ teamId: z.string() }).partial();
const asked = z.object({ part: named.optional(), key: named.optional() });

/** Start hook on reads: each part or member names its team, and only a member reads it. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { list: members.controller },
  run: ({ list }, { input }) => {
    const { part, key } = asked.parse(input.input);
    const teamId = part?.teamId ?? key?.teamId ?? "";
    return list.of({ teamId, userId: input.meta.who ?? "" }).get()
      ? undefined
      : input.refuse({ notMember: teamId });
  },
});

/** The member check each call runs: is the caller in this team? */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: user.required },
  run: ({ list, me }, { input }) =>
    list.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

const gone = { kind: "gone" } as const;

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { list: members.controller, me: user.required },
  run: ({ list, me }, { input }) => {
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

    const key = { teamId: input.teamId, id: input.id };
    const issue = list.of(key).get();
    if (!issue) return gone;

    if (issue.version !== input.version) return { kind: "stale" as const, version: issue.version };

    list.update(key, (i) => ({ ...i, state: input.state, version: i.version + 1 }));
    return { kind: "moved" as const, version: issue.version + 1 };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: { inTeam, found: issues.controller, list: comments.controller, me: user.required },
  run: ({ inTeam, found, list, me }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return gone;
    if (!found.of({ teamId: input.teamId, id: input.issueId }).get()) return gone;
    list.set({
      teamId: input.teamId,
      issueId: input.issueId,
      id: random.uuid(),
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
