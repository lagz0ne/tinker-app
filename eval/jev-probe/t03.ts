import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

const { hook } = transport;

// The server's work for `issueApi`. Each op writes one member of a keyed cell; `issueBoard` tells
// every tab that reads its part. A call or a read names its caller in its meta (`who`).

/** The caller. `signedIn` binds it from the message's meta. */
const who = tag<string>({ label: "issues.who" });

/** Start hook, calls and reads: no `who` in the meta is refused; else the caller is bound. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: async (_, { input }) => {
    const name = input.meta.who;
    return name ? { tags: [who(name)] } : input.refuse({ signIn: true });
  },
});

/** Start hook, reads: a part of a team goes to its members only. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { list: members.controller, me: who.required },
  run: async ({ list, me }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (!teamId) return input.refuse({ notMember: "" });
    return list.of({ teamId, userId: me }).get() ? undefined : input.refuse({ notMember: teamId });
  },
});

/** The member check each call runs: is the caller in this team? */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: who.required },
  run: ({ list, me }, { input }) => Boolean(list.of({ teamId: input.teamId, userId: me }).get()),
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { list: members.controller, me: who.required },
  run: ({ list, me }, { input }) => {
    if (list.where({ teamId: input.teamId }).get().length) return { kind: "exists" as const };
    list.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { list: members.controller, inTeam },
  run: ({ list, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, inTeam },
  run: ({ list, inTeam }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
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
  depends: { list: issues.controller, inTeam },
  run: ({ list, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };

    const key = { teamId: input.teamId, id: input.id };
    const issue = list.of(key).get();
    if (!issue) return { kind: "gone" as const };

    if (issue.version !== input.version) return { kind: "stale" as const, version: issue.version };

    const version = issue.version + 1;
    list.update(key, (i) => ({ ...i, state: input.state, version }));
    return { kind: "moved" as const, version };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: {
    list: comments.controller,
    found: issues.controller,
    inTeam,
    me: who.required,
  },
  run: ({ list, found, inTeam, me }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };

    if (!found.of({ teamId: input.teamId, id: input.issueId }).get()) {
      return { kind: "gone" as const };
    }

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
