import { operation, tag, transport } from "@tinker/core";
import { z } from "zod";

import { comments, issues, issueStates, members, teams } from "./contract";

// The server's work for `issueApi`. Each op writes members of the keyed cells; `issueBoard` tells
// every member's tab that reads the part, and the tab asks for that part alone.

/** Who calls: the `signedIn` hook binds it from the request. A real app reads its session. */
export const viewer = tag<string>({ label: "issues.viewer" });

/** Every call and every read: no `x-who` header, no service. A test stand-in for sign-in. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  depends: { req: transport.request.required },
  run: ({ req }, { input }) => {
    const who = req.headers.get("x-who");
    return who ? { tags: [viewer(who)] } : input.refuse({ signIn: true });
  },
});

/** Every read of a part: the part's team must have the viewer as a member (ADR 0138 rule 14). */
export const memberOnly = operation({
  label: "issues.memberOnly",
  input: transport.hook.start,
  depends: { req: transport.request.required, list: members.controller },
  run: ({ req, list }, { input }) => {
    const userId = req.headers.get("x-who") ?? "";
    const teamId = String(Object(Object(input.input).part).teamId ?? "");
    const ok = list.of({ teamId, userId }).get() !== undefined;
    return ok ? undefined : input.refuse({ notMember: teamId });
  },
});

/** A call's team check: the viewer is a member of the team the input names. */
const isMember = operation({
  label: "issues.isMember",
  input: z.object({ teamId: z.string() }),
  depends: { list: members.controller, me: viewer.required },
  run: ({ list, me }, { input }) =>
    list.of({ teamId: input.teamId, userId: me }).get() !== undefined,
});

/**
 * The rank of a card dropped in a lane: before `beforeId`, or at the end when it is null. Cards
 * sort by rank, low first; a drop between two cards takes the middle.
 */
const rankIn = operation({
  label: "issues.rankIn",
  input: z.object({
    teamId: z.string(),
    state: z.enum(issueStates),
    moving: z.string().nullable(),
    beforeId: z.string().nullable(),
  }),
  depends: { list: issues.controller },
  run: ({ list }, { input }) => {
    const lane = list
      .where({ teamId: input.teamId })
      .get()
      .filter((i) => i.state === input.state && i.id !== input.moving)
      .toSorted((a, b) => a.rank - b.rank);

    const at = input.beforeId === null ? -1 : lane.findIndex((i) => i.id === input.beforeId);
    const next = lane[at];
    const last = lane.at(-1);
    if (at === -1 || !next) return (last?.rank ?? 0) + 1;

    const prev = lane[at - 1];
    return prev ? (prev.rank + next.rank) / 2 : next.rank - 1;
  },
});

export const createTeam = operation({
  label: "team.create.do",
  input: z.object({ key: z.string(), name: z.string() }),
  depends: { all: teams.controller, team: members.controller, me: viewer.required },
  run: ({ all, team, me }, { input, random }) => {
    const id = random.uuid();
    all.set({ teamId: id, key: input.key, name: input.name, seq: 0 });
    team.set({ teamId: id, userId: me });
    return { id };
  },
});

export const addMember = operation({
  label: "team.addMember.do",
  input: z.object({ teamId: z.string(), userId: z.string() }),
  depends: { team: members.controller, member: isMember.controller },
  run: ({ team, member }, { input }) => {
    if (!member.run({ input: { teamId: input.teamId } })) return { kind: "gone" as const };
    team.set({ teamId: input.teamId, userId: input.userId });
    return { kind: "added" as const };
  },
});

export const createIssue = operation({
  label: "issue.create.do",
  input: z.object({ teamId: z.string(), title: z.string(), state: z.enum(issueStates) }),
  depends: {
    all: teams.controller,
    list: issues.controller,
    member: isMember.controller,
    rank: rankIn.controller,
  },
  run: ({ all, list, member, rank }, { input, random }) => {
    const owner = all.of({ teamId: input.teamId }).get();
    if (!owner || !member.run({ input: { teamId: input.teamId } })) {
      throw new Error("NotMember");
    }

    const number = owner.seq + 1;
    all.update({ teamId: owner.teamId }, (t) => ({ ...t, seq: number }));

    const place = { ...input, moving: null, beforeId: null };
    const id = random.uuid();
    const at = rank.run({ input: place });
    list.set({ ...input, id, number, rank: at, version: 1 });

    return { id, number };
  },
});

export const moveIssue = operation({
  label: "issue.move.do",
  input: z.object({
    teamId: z.string(),
    id: z.string(),
    version: z.number(),
    state: z.enum(issueStates),
    beforeId: z.string().nullable(),
  }),
  depends: { list: issues.controller, member: isMember.controller, rank: rankIn.controller },
  run: ({ list, member, rank }, { input }) => {
    const key = { teamId: input.teamId, id: input.id };
    const now = list.of(key).get();
    if (!now || !member.run({ input: { teamId: input.teamId } })) {
      return { kind: "gone" as const };
    }
    if (now.version !== input.version) return { kind: "stale" as const, version: now.version };

    const place = { ...input, moving: input.id };
    const at = rank.run({ input: place });
    const version = now.version + 1;
    list.update(key, (i) => ({ ...i, state: input.state, rank: at, version }));

    return { kind: "moved" as const, version };
  },
});

export const addComment = operation({
  label: "comment.add.do",
  input: z.object({ teamId: z.string(), issueId: z.string(), text: z.string() }),
  depends: {
    list: issues.controller,
    thread: comments.controller,
    member: isMember.controller,
    me: viewer.required,
  },
  run: ({ list, thread, member, me }, { input, random, clock }) => {
    const issue = list.of({ teamId: input.teamId, id: input.issueId }).get();
    if (!issue || !member.run({ input: { teamId: input.teamId } })) {
      return { kind: "gone" as const };
    }

    const id = random.uuid();
    const at = clock.currentTimeMillis();
    thread.set({ ...input, id, author: me, at });

    return { kind: "added" as const, id };
  },
});

/** The server's side of `issueApi`, by address: `issues.api({ implement: issueOps })`. */
export const issueOps = {
  "team.create": createTeam,
  "team.addMember": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "comment.add": addComment,
} as const;
