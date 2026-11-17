import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issues, members } from "./contract";

const { hook } = transport;

const who = tag<string>({ label: "issues.who" });

export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: (_deps, { input }) => {
    const name = input.meta.who;
    return name ? { tags: [who(name)] } : input.refuse({ notSignedIn: true });
  },
});

export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { members: members.controller },
  run: ({ members }, { input }) => {
    const part = (input.input as { part?: { teamId?: string } }).part;
    const teamId = part?.teamId;
    const name = input.meta.who;

    if (!name) return input.refuse({ notSignedIn: true });
    if (!teamId) return input.refuse({ notMember: teamId });
    if (!members.of({ teamId, userId: name }).get()) return input.refuse({ notMember: teamId });
  },
});

export const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string(), who: z.string() }),
  depends: { members: members.controller },
  run: ({ members }, { input }) =>
    members.of({ teamId: input.teamId, userId: input.who }).get() !== undefined,
});

const teamCreate = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { members: members.controller, who },
  run: ({ members, who }, { input }) => {
    if (members.where({ teamId: input.teamId }).get().length > 0) {
      return { kind: "exists" as const };
    }

    members.set({ teamId: input.teamId, userId: who });

    return { kind: "created" as const };
  },
});

const teamAdd = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { members: members.controller, inTeam, who },
  run: ({ members, inTeam, who }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId, who } })) return { kind: "gone" as const };

    members.set({ teamId: input.teamId, userId: input.userId });

    return { kind: "added" as const };
  },
});

const issueCreate = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { issues: issues.controller, inTeam, who },
  run: ({ issues, inTeam, who }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId, who } })) return { kind: "gone" as const };

    const number =
      issues
        .where({ teamId: input.teamId })
        .get()
        .reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
    const id = random.uuid();

    issues.set({
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

const issueMove = operation({
  label: "issue.move.do",
  input: issueApi["issue.move"].input,
  depends: { issues: issues.controller, inTeam, who },
  run: ({ issues, inTeam, who }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId, who } })) return { kind: "gone" as const };

    const found = issues.of({ teamId: input.teamId, id: input.id }).get();
    if (!found) return { kind: "gone" as const };
    if (found.version !== input.version) {
      return { kind: "stale" as const, version: found.version };
    }

    const version = found.version + 1;

    issues.update({ teamId: input.teamId, id: input.id }, (issue) => ({
      ...issue,
      state: input.state,
      version,
    }));

    return { kind: "moved" as const, version };
  },
});

const commentAdd = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: { comments: comments.controller, issues: issues.controller, inTeam, who },
  run: ({ comments, issues, inTeam, who }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId, who } })) return { kind: "gone" as const };

    const found = issues.of({ teamId: input.teamId, id: input.issueId }).get();
    if (!found) return { kind: "gone" as const };

    comments.set({
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
  "team.create": teamCreate,
  "team.add": teamAdd,
  "issue.create": issueCreate,
  "issue.move": issueMove,
  "comment.add": commentAdd,
} as const;
