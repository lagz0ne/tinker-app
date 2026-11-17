import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues as issueRows, members } from "./contract";

const { hook } = transport;

/** The caller a signed-in message names. `signedIn` binds it for the rest of the call. */
export const user = tag<string>({ label: "issues.user" });

export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: (_, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [user(who)] } : input.refuse({ signIn: true });
  },
});

/** The member check each call runs, in the call's own trace. */
export const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { members, who: user.required },
  run: ({ members, who }, { input }) =>
    members.some((member) => member.teamId === input.teamId && member.userId === who),
});

/** The read guard: a team's part goes to that team's members only. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { members, who: user.required },
  run: ({ members, who }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (!teamId) return;
    const member = members.some((one) => one.teamId === teamId && one.userId === who);
    return member ? undefined : input.refuse({ notMember: teamId });
  },
});

export const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { members: members.controller, who: user.required },
  run: ({ members, who }, { input }) => {
    const teamId = input.teamId;
    if (members.where({ teamId }).get().length > 0) {
      return { kind: "exists" as const };
    }
    members.set({ teamId, userId: who });
    return { kind: "created" as const };
  },
});

export const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { members: members.controller, check: inTeam },
  run: ({ members, check }, { input }) => {
    if (!check.run({ input: { teamId: input.teamId } })) {
      return { kind: "gone" as const };
    }
    members.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

export const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issueRows.controller, check: inTeam },
  run: ({ list, check }, { input, random }) => {
    if (!check.run({ input: { teamId: input.teamId } })) {
      return { kind: "gone" as const };
    }
    const teamId = input.teamId;
    const number =
      list
        .where({ teamId })
        .get()
        .reduce((top, issue) => Math.max(top, issue.number), 0) + 1;
    list.set({
      teamId,
      id: random.uuid(),
      number,
      title: input.title,
      state: "backlog",
      version: 1,
    });
    return { kind: "created" as const, number };
  },
});

export const moveIssue = operation({
  label: "issue.move.do",
  input: issueApi["issue.move"].input,
  depends: { list: issueRows.controller, check: inTeam },
  run: ({ list, check }, { input }) => {
    if (!check.run({ input: { teamId: input.teamId } })) {
      return { kind: "gone" as const };
    }

    const key = { teamId: input.teamId, id: input.id };
    const issue = list.of(key).get();

    if (!issue) return { kind: "gone" as const };
    if (issue.version !== input.version) {
      return { kind: "stale" as const, version: issue.version };
    }

    const version = issue.version + 1;
    list.update(key, (one) => ({ ...one, state: input.state, version }));
    return { kind: "moved" as const, version };
  },
});

export const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: {
    list: issueRows.controller,
    threads: comments.controller,
    check: inTeam,
    who: user.required,
  },
  run: ({ list, threads, check, who }, { input, random }) => {
    const teamId = input.teamId;
    if (!check.run({ input: { teamId } })) return { kind: "gone" as const };
    if (!list.of({ teamId, id: input.issueId }).get()) {
      return { kind: "gone" as const };
    }
    threads.set({
      teamId,
      issueId: input.issueId,
      id: random.uuid(),
      author: who,
      text: input.text,
    });
    return { kind: "added" as const };
  },
});

/** The server's side of `issues.api`, by address: `issues.api({ implement: issueOps })`. */
export const issueOps = {
  "team.create": createTeam,
  "team.add": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "comment.add": addComment,
} as const;
