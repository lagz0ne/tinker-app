import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

const { hook } = transport;

// The server's work for `issueApi`, and the hooks that guard it. Every write goes through a
// served cell: `issueBoard` then tells each tab that reads that part.

/** The caller, bound by `signedIn` from each message's `who` meta. */
const who = tag<string>({ label: "issues.who" });

export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: async (_, { input }) => {
    const caller = input.meta.who?.trim();
    return caller ? { tags: [who(caller)] } : input.refuse({ signIn: true });
  },
});

export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { list: members.controller, me: who.required },
  run: async ({ list, me }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (teamId && list.of({ teamId, userId: me }).get()) return;
    return input.refuse({ notMember: teamId });
  },
});

/** The member check each call runs. `team.create` does not need it: its caller makes the team. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: who.required },
  run: ({ list, me }, { input }) =>
    list.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { list: members.controller, me: who.required },
  run: ({ list, me }, { input }) => {
    if (list.where({ teamId: input.teamId }).get().length > 0) {
      return { kind: "exists" as const };
    }
    list.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { list: members.controller, check: inTeam },
  run: ({ list, check }, { input }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, check: inTeam },
  run: ({ list, check }, { input, random }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    const numbers = list
      .where({ teamId: input.teamId })
      .get()
      .map((issue) => issue.number);
    const number = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
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
  depends: { list: issues.controller, check: inTeam },
  run: ({ list, check }, { input }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    const one = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!one) return { kind: "gone" as const };
    if (input.version !== one.version) return { kind: "stale" as const, version: one.version };

    const version = one.version + 1;
    list.update({ teamId: input.teamId, id: input.id }, (issue) => ({
      ...issue,
      state: input.state,
      version,
    }));
    return { kind: "moved" as const, version };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: {
    issues: issues.controller,
    list: comments.controller,
    me: who.required,
    check: inTeam,
  },
  run: ({ issues: issueList, list, me, check }, { input, random }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    if (!issueList.of({ teamId: input.teamId, id: input.issueId }).get()) {
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
