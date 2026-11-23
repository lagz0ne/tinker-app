import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import { archived, issueApi, issueBoard, issues, labels, members } from "./contract";

// The server's work for `issueApi`. Each op writes members of the keyed cells; `issueBoard` tells
// every member's tab that reads the part, and the tab asks for that part alone.

/** Who calls: `signedIn` binds it for each call. */
const caller = tag<string>({ label: "issues.caller" });

/** Every call and ask: no `who` in its meta, no service; else it runs as the caller. */
export const signedIn = operation({
  label: "issues.signedIn",
  input: transport.hook.start,
  run: (_, { input }) => {
    const me = input.meta.who;
    return me ? { tags: [caller(me)] } : input.refuse({ signIn: true });
  },
});

/** The member check: the caller's place in the team the input names, if they have one. Calls
 * and reads run it. */
const inTeam = operation({
  label: "issues.inTeam",
  input: z.object({ teamId: z.string() }),
  depends: { team: members.controller, me: caller.required },
  run: ({ team, me }, { input }) => team.of({ teamId: input.teamId, userId: me }).get(),
});

/** Every read of a part: the caller must be a member of the part's team (ADR 0138 rule 14). */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { ok: inTeam },
  run: ({ ok }, { input }) => {
    const teamId = issueBoard.part(input)?.teamId ?? "";
    return ok.run({ input: { teamId } }) ? undefined : input.refuse({ notMember: teamId });
  },
});

/** Every change to a team starts here: `gone` outside the team, `forbidden` for a viewer, then
 * `archived` for an archived team (as HTTP: 404, 403, then 423). The member check comes first,
 * so nobody outside the team learns that it is archived. */
const canWrite = operation({
  label: "issues.canWrite",
  input: z.object({ teamId: z.string() }),
  depends: { ok: inTeam, shut: archived.controller },
  run: ({ ok, shut }, { input }) => {
    const place = ok.run({ input });
    if (!place) return { kind: "gone" as const };
    if (place.role === "viewer") return { kind: "forbidden" as const };
    if (shut.of({ teamId: input.teamId }).get()) return { kind: "archived" as const };

    return { kind: "ok" as const };
  },
});

const createTeam = operation({
  label: "team.create.do",
  input: issueApi["team.create"].input,
  depends: { team: members.controller, me: caller.required },
  run: ({ team, me }, { input }) => {
    if (team.where(input).get().length) return { kind: "exists" as const, teamId: input.teamId };

    team.set({ ...input, userId: me, role: "member" });
    return { kind: "created" as const, teamId: input.teamId };
  },
});

const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { team: members.controller, can: canWrite },
  run: ({ team, can }, { input }) => {
    const now = can.run({ input });
    if (now.kind !== "ok") return now;

    team.set(input);
    return { kind: "added" as const };
  },
});

/** A number one past the team's last: ENG-1, ENG-2. One writer, so no gap and no twin. */
const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, can: canWrite },
  run: ({ list, can }, { input, random }) => {
    const now = can.run({ input });
    if (now.kind !== "ok") return now;

    const team = list.where({ teamId: input.teamId }).get();
    const number = Math.max(0, ...team.map((i) => i.number)) + 1;
    list.set({ ...input, id: random.uuid(), number, state: "backlog", version: 1 });
    return { kind: "created" as const, number };
  },
});

/** The issue a change names, at the version it saw. The write check comes first, as in every
 * call: nobody outside the team reaches a read. A move and a rename both start here. */
const atVersion = operation({
  label: "issues.atVersion",
  input: z.object({ teamId: z.string(), id: z.string(), version: z.number() }),
  depends: { list: issues.controller, can: canWrite },
  run: ({ list, can }, { input }) => {
    const may = can.run({ input });
    if (may.kind !== "ok") return may;

    const now = list.of({ teamId: input.teamId, id: input.id }).get();
    if (!now) return { kind: "gone" as const };
    if (now.version !== input.version) return { kind: "stale" as const, version: now.version };

    return { kind: "now" as const, issue: now };
  },
});

const moveIssue = operation({
  label: "issue.move.do",
  input: issueApi["issue.move"].input,
  depends: { list: issues.controller, at: atVersion },
  run: ({ list, at }, { input }) => {
    const now = at.run({ input });
    if (now.kind !== "now") return now;

    const version = now.issue.version + 1;
    list.set({ ...now.issue, state: input.state, version });
    return { kind: "moved" as const, version };
  },
});

const renameIssue = operation({
  label: "issue.rename.do",
  input: issueApi["issue.rename"].input,
  depends: { list: issues.controller, at: atVersion },
  run: ({ list, at }, { input }) => {
    const now = at.run({ input });
    if (now.kind !== "now") return now;

    const version = now.issue.version + 1;
    list.set({ ...now.issue, title: input.title, version });
    return { kind: "renamed" as const, version };
  },
});

/** Put a label on an issue, or take it off. Either way the issue gets a new version. */
const labelIssue = operation({
  label: "issue.label.do",
  input: issueApi["issue.label"].input,
  depends: { list: issues.controller, tags: labels.controller, at: atVersion },
  run: ({ list, tags, at }, { input }) => {
    const now = at.run({ input });
    if (now.kind !== "now") return now;

    const key = { teamId: input.teamId, id: input.id, name: input.name };
    if (input.on) tags.set(key);
    else tags.delete(key);
    const version = now.issue.version + 1;
    list.set({ ...now.issue, version });
    return { kind: "labeled" as const, version };
  },
});

/** Archive a team. A second archive answers the same and writes nothing. */
const archiveTeam = operation({
  label: "team.archive.do",
  input: issueApi["team.archive"].input,
  depends: { shut: archived.controller, can: canWrite },
  run: ({ shut, can }, { input }) => {
    const now = can.run({ input });
    if (now.kind !== "ok") return now;

    shut.set({ teamId: input.teamId });
    return { kind: "archived" as const };
  },
});

/** The server's side of `issueApi`, by address: `issues.api({ implement: issueOps })`. */
export const issueOps = {
  "team.create": createTeam,
  "team.add": addMember,
  "issue.create": createIssue,
  "issue.move": moveIssue,
  "issue.rename": renameIssue,
  "issue.label": labelIssue,
  "team.archive": archiveTeam,
} as const;
