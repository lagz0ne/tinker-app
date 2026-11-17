import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueBoard, issues, members, states } from "./contract";

// The server's work for `issueApi`. Every call names a team: the guard binds the caller, and each
// call checks that the caller is in that team before it writes. A read is guarded by `membersOnly`.

const { hook } = transport;

/** The caller, bound by `signedIn` from each message's meta. */
const viewer = tag<string>({ label: "issues.viewer" });

const teamInput = z.object({ teamId: z.string() });

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
  depends: { me: viewer.required, members: members.controller },
  run: ({ me, members }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (!teamId) return;
    if (!members.of({ teamId, userId: me }).get()) return input.refuse({ notMember: teamId });
    return undefined;
  },
});

/** The member check a call runs before it reads or writes the team. */
const inTeam = operation({
  label: "issues.inTeam",
  input: teamInput,
  depends: { me: viewer.required, members: members.controller },
  run: ({ me, members }, { input }) =>
    Boolean(members.of({ teamId: input.teamId, userId: me }).get()),
});

const createTeam = operation({
  label: "team.create.do",
  input: z.object({
    teamId: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/),
  }),
  depends: { me: viewer.required, members: members.controller },
  run: ({ me, members }, { input }) => {
    const here = members.where({ teamId: input.teamId }).get();
    if (here.length > 0) return { kind: "exists" as const };
    members.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: z.object({ teamId: z.string(), userId: z.string().trim().min(1) }),
  depends: { members: members.controller, inTeam },
  run: ({ members, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    members.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: z.object({
    teamId: z.string(),
    title: z.string().trim().min(1).max(200),
  }),
  depends: { issues: issues.controller, inTeam },
  run: ({ issues, inTeam }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };

    const list = issues.where({ teamId: input.teamId }).get();
    const number = list.reduce((last, item) => (item.number > last ? item.number : last), 0) + 1;
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

const moveIssue = operation({
  label: "issue.move.do",
  input: z.object({
    teamId: z.string(),
    id: z.string(),
    version: z.number(),
    state: z.enum(states),
  }),
  depends: { issues: issues.controller, inTeam },
  run: ({ issues, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };

    const item = issues.of({ teamId: input.teamId, id: input.id }).get();
    if (!item) return { kind: "gone" as const };
    if (item.version !== input.version) return { kind: "stale" as const, version: item.version };

    const version = item.version + 1;
    issues.update({ teamId: input.teamId, id: input.id }, (issue) => ({
      ...issue,
      state: input.state,
      version,
    }));
    return { kind: "moved" as const, version };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: z.object({
    teamId: z.string(),
    issueId: z.string(),
    text: z.string().trim().min(1).max(5000),
  }),
  depends: {
    me: viewer.required,
    issues: issues.controller,
    comments: comments.controller,
    inTeam,
  },
  run: ({ me, issues, comments, inTeam }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    if (!issues.of({ teamId: input.teamId, id: input.issueId }).get()) {
      return { kind: "gone" as const };
    }
    const id = random.uuid();
    comments.set({
      teamId: input.teamId,
      issueId: input.issueId,
      id,
      author: me,
      text: input.text,
    });
    return { kind: "added" as const };
  },
});

/** The server's side of `issueApi`, by address: `issues.api({ implement: issueOps })`. */
export const issueOps = {
  "team.create": createTeam,
  "team.add": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "comment.add": addComment,
} as const;
