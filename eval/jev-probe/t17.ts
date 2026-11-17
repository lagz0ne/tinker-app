import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueBoard, issues, members } from "./contract";

const { hook } = transport;

// The server's work for `issueApi`, and the hooks that guard it. Only these ops write the cells;
// `issueBoard` tells every tab that reads a part.

/** The caller. `signedIn` binds it from the message's meta. */
const user = tag<string>({ label: "issues.user" });

/** Every call and every read names a viewer in `who`; with none, it is refused. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: async (_, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [user(who)] } : input.refuse({ signIn: true });
  },
});

/** A read of a team's part goes only to a member of that team. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { list: members.controller },
  run: async ({ list }, { input }) => {
    const part = issueBoard.part(input);
    const teamId = part && "teamId" in part ? String(part.teamId) : "";
    const who = input.meta.who ?? "";
    return list.of({ teamId, userId: who }).get() ? undefined : input.refuse({ notMember: teamId });
  },
});

const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: user.required },
  run: ({ list, me }, { input }) =>
    list.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

const gone = { kind: "gone" as const };

export const createTeam = operation({
  label: "team.create.do",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: user.required },
  run: ({ list, me }, { input }) => {
    if (list.where({ teamId: input.teamId }).get().length > 0) return { kind: "exists" as const };
    list.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

export const addMember = operation({
  label: "team.add.do",
  input: z.object({ teamId: z.string(), userId: z.string() }),
  depends: { list: members.controller, inTeam },
  run: ({ list, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return gone;
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

export const createIssue = operation({
  label: "issue.create.do",
  input: z.object({ teamId: z.string(), title: z.string() }),
  depends: { list: issues.controller, inTeam },
  run: ({ list, inTeam }, { input, random }) => {
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

export const moveIssue = operation({
  label: "issue.move.do",
  input: z.object({
    teamId: z.string(),
    id: z.string(),
    version: z.number(),
    state: z.enum(["backlog", "todo", "doing", "done"]),
  }),
  depends: { list: issues.controller, inTeam },
  run: ({ list, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return gone;

    const key = { teamId: input.teamId, id: input.id };
    const issue = list.of(key).get();
    if (!issue) return gone;

    if (issue.version !== input.version) return { kind: "stale" as const, version: issue.version };

    list.update(key, (i) => ({ ...i, state: input.state, version: i.version + 1 }));
    return { kind: "moved" as const, version: issue.version + 1 };
  },
});

export const addComment = operation({
  label: "comment.add.do",
  input: z.object({ teamId: z.string(), issueId: z.string(), text: z.string() }),
  depends: { list: comments.controller, found: issues.controller, inTeam, me: user.required },
  run: ({ list, found, inTeam, me }, { input, random }) => {
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
