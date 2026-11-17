import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

const { hook } = transport;

const viewer = tag<string>({ label: "issues.viewer" });

export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: (_, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [viewer(who)] } : input.refuse({ signIn: true });
  },
});

export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { list: members.controller, me: viewer.required },
  run: ({ list, me }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (typeof teamId !== "string") return input.refuse({ notMember: "" });
    if (!list.of({ teamId, userId: me }).get()) return input.refuse({ notMember: teamId });
    return undefined;
  },
});

const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: viewer.required },
  run: ({ list, me }, { input }) => {
    if (!list.of({ teamId: input.teamId, userId: me }).get()) return { kind: "gone" as const };
    return undefined;
  },
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { list: members.controller, me: viewer.required },
  run: ({ list, me }, { input }) => {
    if (list.where({ teamId: input.teamId }).get().length > 0) return { kind: "exists" as const };
    list.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { list: members.controller, check: inTeam },
  run: ({ list, check }, { input }) => {
    const gone = check.run({ input: { teamId: input.teamId } });
    if (gone) return gone;
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, check: inTeam },
  run: ({ list, check }, { input, random }) => {
    const gone = check.run({ input: { teamId: input.teamId } });
    if (gone) return gone;

    const here = list.where({ teamId: input.teamId }).get();
    const number = here.reduce((next, issue) => Math.max(next, issue.number + 1), 1);
    const id = random.uuid();
    list.set({
      teamId: input.teamId,
      id,
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
    const gone = check.run({ input: { teamId: input.teamId } });
    if (gone) return gone;

    const issue = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!issue) return { kind: "gone" as const };
    if (issue.version !== input.version) return { kind: "stale" as const, version: issue.version };

    list.update({ teamId: input.teamId, id: input.id }, (before) => ({
      ...before,
      state: input.state,
      version: before.version + 1,
    }));

    return { kind: "moved" as const, version: issue.version + 1 };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: {
    comments: comments.controller,
    issues: issues.controller,
    check: inTeam,
    me: viewer.required,
  },
  run: ({ comments: list, issues: issueList, check, me }, { input, random }) => {
    const gone = check.run({ input: { teamId: input.teamId } });
    if (gone) return gone;
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

export const issueOps = {
  "team.create": createTeam,
  "team.add": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "comment.add": addComment,
} as const;
