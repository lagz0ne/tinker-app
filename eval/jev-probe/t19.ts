import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { comments, issueApi, issueBoard, issues, members } from "./contract";

const { hook } = transport;

// The server's work for `issueApi`. Each call writes a keyed cell; `issueBoard` tells every tab
// that reads the part, and the tab asks for that part alone. No op sends anything by hand.

/** Who called, bound by `signedIn` from the message's meta. */
const user = tag<string>({ label: "issues.user" });

/** A call or a read with no `who` in its meta is refused; a signed-in caller binds `user`. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: hook.start,
  run: (_deps, { input }) => {
    const who = input.meta.who;
    return who ? { tags: [user(who)] } : input.refuse({ signIn: true });
  },
});

/** The member check each call runs: `member`, or `gone` when the caller is not in the team. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { members: members.controller, who: user.required },
  run: ({ members, who }, { input }) =>
    members.of({ teamId: input.teamId, userId: who }).get()
      ? { kind: "member" as const }
      : { kind: "gone" as const },
});

/** A read of a team's part goes only to that team's members; any other read is refused. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: hook.start,
  depends: { members: members.controller, who: user.required },
  run: ({ members, who }, { input }) => {
    const part = issueBoard.part(input);
    const teamId = part?.teamId;
    if (typeof teamId !== "string") return;

    if (!members.of({ teamId, userId: who }).get()) return input.refuse({ notMember: teamId });
  },
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { members: members.controller, who: user.required },
  run: ({ members, who }, { input }) => {
    if (members.where({ teamId: input.teamId }).get().length > 0) {
      return { kind: "exists" as const };
    }

    members.set({ teamId: input.teamId, userId: who });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { members: members.controller, check: inTeam },
  run: ({ members, check }, { input }) => {
    if (check.run({ input: { teamId: input.teamId } }).kind === "gone") {
      return { kind: "gone" as const };
    }

    members.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, check: inTeam },
  run: ({ list, check }, { input, random }) => {
    if (check.run({ input: { teamId: input.teamId } }).kind === "gone") {
      return { kind: "gone" as const };
    }

    const here = list.where({ teamId: input.teamId }).get();
    const number = here.reduce((max, issue) => Math.max(max, issue.number), 0) + 1;
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
    if (check.run({ input: { teamId: input.teamId } }).kind === "gone") {
      return { kind: "gone" as const };
    }

    const issue = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!issue) return { kind: "gone" as const };

    if (issue.version !== input.version) {
      return { kind: "stale" as const, version: issue.version };
    }

    list.update({ teamId: input.teamId, id: input.id }, (item) => ({
      ...item,
      state: input.state,
      version: item.version + 1,
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
    who: user.required,
  },
  run: ({ list, thread, check, who }, { input, random }) => {
    if (check.run({ input: { teamId: input.teamId } }).kind === "gone") {
      return { kind: "gone" as const };
    }

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

/** The server's side of `issueApi`, by address: `issueApi({ implement: issueOps })`. */
export const issueOps = {
  "team.create": createTeam,
  "team.add": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "comment.add": addComment,
} as const;
