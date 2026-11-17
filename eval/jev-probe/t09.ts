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

const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { members: members.controller, me: viewer.required },
  run: ({ members, me }, { input }) =>
    members.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { check: inTeam },
  run: ({ check }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (teamId === undefined) return input.refuse({ notMember: teamId });
    if (!check.run({ input: { teamId } })) return input.refuse({ notMember: teamId });
    return undefined;
  },
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { members: members.controller, me: viewer.required },
  run: ({ members, me }, { input }) => {
    if (members.where({ teamId: input.teamId }).get().length > 0) {
      return { kind: "exists" as const };
    }
    members.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { members: members.controller, check: inTeam },
  run: ({ members, check }, { input }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    members.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, check: inTeam },
  run: ({ list, check }, { input, random }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };

    let number = 1;
    for (const item of list.where({ teamId: input.teamId }).get()) {
      if (item.number >= number) number = item.number + 1;
    }

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
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };

    const issue = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!issue) return { kind: "gone" as const };
    if (issue.version !== input.version) {
      return { kind: "stale" as const, version: issue.version };
    }

    list.update({ teamId: input.teamId, id: input.id }, (current) => ({
      ...current,
      state: input.state,
      version: current.version + 1,
    }));
    return { kind: "moved" as const, version: issue.version + 1 };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: {
    list: issues.controller,
    thread: comments.controller,
    check: inTeam,
    me: viewer.required,
  },
  run: ({ list, thread, check, me }, { input, random }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    if (!list.of({ teamId: input.teamId, id: input.issueId }).get()) {
      return { kind: "gone" as const };
    }
    thread.set({
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
