import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

const { hook } = transport;

// The server's work for `issueApi`. `signedIn` binds the caller from the message's meta; every
// call that names a team also runs `inTeam`, so a signed-in outsider learns `gone`. The board's
// reads run `membersOnly`, which refuses a part whose team does not hold the caller.

/** The caller, bound by `signedIn` for one call or read. */
const user = tag<string>({ label: "issues.user" });

/** The caller's name from the transport's `meta`, or a refusal when the tab has not signed in. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: async (_deps, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [user(who)] } : input.refuse({ signIn: true });
  },
});

/** A read's guard: the part it names must belong to a team that holds the caller. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { list: members.controller, me: user.required },
  run: ({ list, me }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId;
    if (teamId === undefined) return;
    const ours = list
      .where({ teamId })
      .get()
      .some((m) => m.userId === me);
    return ours ? undefined : input.refuse({ notMember: teamId });
  },
});

/** The member check each call runs, as its own span: true when the caller is in the team. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: user.required },
  run: ({ list, me }, { input }) =>
    list
      .where({ teamId: input.teamId })
      .get()
      .some((m) => m.userId === me),
});

const teamCreate = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { list: members.controller, me: user.required },
  run: ({ list, me }, { input }) => {
    if (list.where({ teamId: input.teamId }).get().length > 0) return { kind: "exists" as const };
    list.set({ teamId: input.teamId, userId: me });
    return { kind: "created" as const };
  },
});

const teamAdd = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { list: members.controller, inTeam },
  run: ({ list, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    list.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const issueCreate = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, inTeam },
  run: ({ list, inTeam }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    const here = list.where({ teamId: input.teamId }).get();
    const number = here.reduce((top, issue) => Math.max(top, issue.number), 0) + 1;
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

const issueMove = operation({
  label: "issue.move.do",
  input: issueApi["issue.move"].input,
  depends: { list: issues.controller, inTeam },
  run: ({ list, inTeam }, { input }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };

    const key = { teamId: input.teamId, id: input.id };
    const issue = list.of(key).get();
    if (issue === undefined) return { kind: "gone" as const };

    if (issue.version !== input.version) {
      return { kind: "stale" as const, version: issue.version };
    }

    list.update(key, (old) => ({ ...old, state: input.state, version: old.version + 1 }));

    return { kind: "moved" as const, version: issue.version + 1 };
  },
});

const commentAdd = operation({
  label: "comment.add.do",
  input: issueApi["comment.add"].input,
  depends: { list: comments.controller, issues: issues.controller, inTeam, me: user.required },
  run: ({ list, issues, inTeam, me }, { input, random }) => {
    if (!inTeam.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    if (issues.of({ teamId: input.teamId, id: input.issueId }).get() === undefined) {
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

/** The server's side of `issueApi`, by address: `issues.api({ implement: issueOps })`. */
export const issueOps = {
  "team.create": teamCreate,
  "team.add": teamAdd,
  "issue.create": issueCreate,
  "issue.move": issueMove,
  "comment.add": commentAdd,
} as const;
