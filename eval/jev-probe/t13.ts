import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

const { hook } = transport;

const user = tag<string>({ label: "issues.user" });

export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: (_, { input }) => {
    const who = input.meta.who?.trim();
    return who ? { tags: [user(who)] } : input.refuse({ signIn: true });
  },
});

export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { team: members.controller },
  run: ({ team }, { input }) => {
    const teamId = issueBoard.part({ key: input.key, input: input.input })?.teamId;
    const who = input.meta.who;
    if (teamId === undefined || !who || !team.of({ teamId, userId: who }).get()) {
      return input.refuse({ notMember: teamId });
    }
  },
});

const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { team: members.controller, who: user.required },
  run: ({ team, who }, { input }) =>
    team.of({ teamId: input.teamId, userId: who }).get() !== undefined,
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { team: members.controller, who: user.required },
  run: ({ team, who }, { input }) => {
    const here = team.where({ teamId: input.teamId }).get();
    if (here.length > 0) return { kind: "exists" as const };
    team.set({ teamId: input.teamId, userId: who });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { team: members.controller, check: inTeam },
  run: ({ team, check }, { input }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    team.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, check: inTeam },
  run: ({ list, check }, { input, random }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    const here = list.where({ teamId: input.teamId }).get();
    const number = here.reduce((highest, issue) => Math.max(highest, issue.number), 0) + 1;
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

    const issue = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!issue) return { kind: "gone" as const };

    if (issue.version !== input.version) {
      return { kind: "stale" as const, version: issue.version };
    }

    const version = issue.version + 1;
    list.update({ teamId: input.teamId, id: input.id }, (current) => ({
      ...current,
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
    list: issues.controller,
    thread: comments.controller,
    check: inTeam,
    who: user.required,
  },
  run: ({ list, thread, check, who }, { input, random }) => {
    if (!check.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    if (!list.of({ teamId: input.teamId, id: input.issueId }).get()) {
      return { kind: "gone" as const };
    }
    thread.set({
      teamId: input.teamId,
      issueId: input.issueId,
      id: random.uuid(),
      author: who,
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
