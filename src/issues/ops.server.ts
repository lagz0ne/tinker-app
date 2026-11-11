import { operation, tag, transport } from "@tinker/core";
import { z } from "zod";

import { comments, issueBoard, issues, members, states } from "./contract";

// The server's work for `issueApi`. Each op writes members of the keyed cells; `issueBoard` tells
// every member's tab that reads the part, and the tab asks for that part alone.

/** Who calls: `signedIn` binds it for each call. */
const viewer = tag<string>({ label: "issues.viewer" });

/** Every call and ask: no `who` in its meta, no service; else it runs as the viewer. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  run: (_, { input }) => {
    const me = input.meta.who;
    return me ? { tags: [viewer(me)] } : input.refuse({ signIn: true });
  },
});

/** Every read of a part: the viewer must be a member of the part's team (ADR 0138 rule 14). */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { team: members.controller },
  run: ({ team }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId ?? "";
    const known = team.of({ teamId, userId: input.meta.who ?? "" }).get();
    return known ? undefined : input.refuse({ notMember: teamId });
  },
});

/** A call's check: the viewer is a member of the team the input names. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { team: members.controller, me: viewer.required },
  run: ({ team, me }, { input }) => !!team.of({ teamId: input.teamId, userId: me }).get(),
});

const createTeam = operation({
  label: "team.create.do",
  input: z.object({ teamId: z.string() }),
  depends: { team: members.controller, me: viewer.required },
  run: ({ team, me }, { input }) => {
    if (team.where(input).get().length) return { kind: "exists" as const };

    team.set({ ...input, userId: me });
    return { kind: "created" as const };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: z.object({ teamId: z.string(), userId: z.string() }),
  depends: { team: members.controller, ok: inTeam.controller },
  run: ({ team, ok }, { input }) => {
    if (!ok.run({ input })) return { kind: "gone" as const };

    team.set(input);
    return { kind: "added" as const };
  },
});

/** A number one past the team's last: ENG-1, ENG-2. One writer, so no gap and no twin. */
const createIssue = operation({
  label: "issue.create.do",
  input: z.object({ teamId: z.string(), title: z.string() }),
  depends: { list: issues.controller, ok: inTeam.controller },
  run: ({ list, ok }, { input, random }) => {
    if (!ok.run({ input })) return { kind: "gone" as const };

    const team = list.where({ teamId: input.teamId }).get();
    const number = Math.max(0, ...team.map((i) => i.number)) + 1;
    list.set({ ...input, id: random.uuid(), number, state: "backlog", version: 1 });
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
  depends: { list: issues.controller, ok: inTeam.controller },
  run: ({ list, ok }, { input }) => {
    const key = { teamId: input.teamId, id: input.id };
    const now = list.of(key).get();
    if (!now || !ok.run({ input })) return { kind: "gone" as const };
    if (now.version !== input.version) return { kind: "stale" as const, version: now.version };

    const version = now.version + 1;
    list.update(key, (i) => ({ ...i, state: input.state, version }));
    return { kind: "moved" as const, version };
  },
});

const addComment = operation({
  label: "comment.add.do",
  input: z.object({ teamId: z.string(), issueId: z.string(), text: z.string() }),
  depends: {
    list: issues.controller,
    thread: comments.controller,
    ok: inTeam.controller,
    me: viewer.required,
  },
  run: ({ list, thread, ok, me }, { input, random }) => {
    const there = list.of({ teamId: input.teamId, id: input.issueId }).get();
    if (!there || !ok.run({ input })) return { kind: "gone" as const };

    thread.set({ ...input, id: random.uuid(), author: me });
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
