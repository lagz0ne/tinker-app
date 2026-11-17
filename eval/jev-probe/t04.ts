import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issues, members } from "./contract";

const { hook } = transport;

// The server's work for `issueApi`. The server is the only writer: each op writes one member of
// a keyed cell, and `issueBoard` sends it to the members of that team who read the part.

/** The caller. `signedIn` binds it from the message's meta; every op reads it. */
const user = tag<string>({ label: "issues.user" });

/** Does this person belong to this team? Each call runs it; `membersOnly` runs it for a read. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string(), userId: z.string() }),
  depends: { list: members.controller },
  run: ({ list }, { input }) => list.of(input).get() !== undefined,
});

/** The start hook on calls and reads: no `who` in the meta is refused. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: async (_, { input }) =>
    input.meta.who ? { tags: [user(input.meta.who)] } : input.refuse({ signIn: true }),
});

/** The start hook on reads: a part of a team goes only to its members. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { inTeam },
  run: async ({ inTeam }, { input }) => {
    const teamId = Object(Object(input.input).part).teamId;
    const userId = input.meta.who;

    return typeof teamId === "string" && userId && inTeam.run({ input: { teamId, userId } })
      ? {}
      : input.refuse({ notMember: teamId });
  },
});

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
  depends: { inTeam, list: members.controller, me: user.required },
  run: ({ inTeam, list, me }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId, userId: me } })) {
      return { kind: "gone" as const };
    }
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { inTeam, list: issues.controller, me: user.required },
  run: ({ inTeam, list, me }, { input, random }) => {
    const { teamId, title } = input;
    if (!inTeam.run({ input: { teamId, userId: me } })) return { kind: "gone" as const };
    const number = list.where({ teamId }).get().length + 1;
    list.set({
      teamId,
      id: random.uuid(),
      number,
      title,
      state: "backlog",
      version: 1,
    });
    return { kind: "created" as const, number };
  },
});

const moveIssue = operation({
  label: "issue.move.do",
  input: issueApi["issue.move"].input,
  depends: { inTeam, list: issues.controller, me: user.required },
  run: ({ inTeam, list, me }, { input }) => {
    const { teamId, id, version, state } = input;
    if (!inTeam.run({ input: { teamId, userId: me } })) return { kind: "gone" as const };

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
    list: comments.controller,
    found: issues.controller,
    me: user.required,
  },
  run: ({ inTeam, list, found, me }, { input, random }) => {
    const { teamId, issueId, text } = input;
    if (!inTeam.run({ input: { teamId, userId: me } })) return { kind: "gone" as const };
    if (!found.of({ teamId, id: issueId }).get()) return { kind: "gone" as const };
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
