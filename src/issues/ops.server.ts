import { operation, tag, transport } from "@tinkered/core";
import { z } from "zod";

import {
  archived,
  changes,
  events,
  issue,
  issueApi,
  issueBoard,
  issues,
  labels,
  members,
} from "./contract";

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

/** Every read of a part: the caller must be a member of the part's team (ADR 0138 rule 14). The
 * caller's own member rows go to the caller, in or out of the team. A part of `members` by
 * `userId` alone goes to that user only. Core asks again for one row by its whole key
 * `{ teamId, userId }`: another user's row takes the team check, as its team's part does. */
export const membersOnly = operation({
  label: "issues.membersOnly",
  input: transport.hook.start,
  depends: { ok: inTeam, me: caller.required },
  run: ({ ok, me }, { input }) => {
    const part = { teamId: "", ...issueBoard.part(input) };
    if ("userId" in part && part.userId === me) return undefined;
    if ("userId" in part && part.teamId === "") return input.refuse({ notYou: part.userId });
    const ask = { input: { teamId: part.teamId } };
    return ok.run(ask) ? undefined : input.refuse({ notMember: part.teamId });
  },
});

/** Who may change the team: `gone` outside the team, `forbidden` for a viewer (as HTTP: 404,
 * then 403). The member check comes first, so nobody outside the team learns more. */
const canChange = operation({
  label: "issues.canChange",
  input: z.object({ teamId: z.string() }),
  depends: { ok: inTeam },
  run: ({ ok }, { input }) => {
    const place = ok.run({ input });
    if (!place) return { kind: "gone" as const };
    if (place.role === "viewer") return { kind: "forbidden" as const };

    return { kind: "ok" as const };
  },
});

/** Every change to a team's work starts here: `canChange`, then `archived` for an archived team
 * (as HTTP 423). Only a delete skips the archive mark. */
const canWrite = operation({
  label: "issues.canWrite",
  input: z.object({ teamId: z.string() }),
  depends: { may: canChange, shut: archived.controller },
  run: ({ may, shut }, { input }) => {
    const now = may.run({ input });
    if (now.kind !== "ok") return now;
    if (shut.of({ teamId: input.teamId }).get()) return { kind: "archived" as const };

    return now;
  },
});

/** Save a change of an issue: the issue at its new version, and the event of that version. Every
 * change of an issue ends here, so none leaves no event (`tinker.json` graph rule). */
const record = operation({
  label: "issues.record",
  input: z.object({ issue, what: z.enum(changes) }),
  depends: { list: issues.controller, log: events.controller, me: caller.required },
  run: ({ list, log, me }, { input }) => {
    const { issue, what } = input;
    list.set(issue);
    log.set({ teamId: issue.teamId, id: issue.id, version: issue.version, by: me, what });
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

/** Add a person, or set the role of one who is in. An assignee is always a `member`: a person
 * made a viewer is taken off each issue of the team, and each such issue is a change of it. */
const addMember = operation({
  label: "team.add.do",
  input: issueApi["team.add"].input,
  depends: { team: members.controller, list: issues.controller, can: canWrite, save: record },
  run: ({ team, list, can, save }, { input }) => {
    const now = can.run({ input });
    if (now.kind !== "ok") return now;

    team.set(input);
    if (input.role === "member") return { kind: "added" as const };

    const theirs = list.where({ teamId: input.teamId }).get();
    for (const one of theirs.filter((i) => i.assignee === input.userId)) {
      const next = { ...one, assignee: undefined, version: one.version + 1 };
      save.run({ input: { issue: next, what: "assigned" } });
    }
    return { kind: "added" as const };
  },
});

/** A number one past the team's last: ENG-1, ENG-2. One writer, so no gap and no twin. */
const createIssue = operation({
  label: "issue.create.do",
  input: issueApi["issue.create"].input,
  depends: { list: issues.controller, can: canWrite, save: record },
  run: ({ list, can, save }, { input, random }) => {
    const now = can.run({ input });
    if (now.kind !== "ok") return now;

    const team = list.where({ teamId: input.teamId }).get();
    const number = Math.max(0, ...team.map((i) => i.number)) + 1;
    const made = { ...input, id: random.uuid(), number, state: "backlog" as const, version: 1 };
    save.run({ input: { issue: made, what: "created" } });
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
  depends: { at: atVersion, save: record },
  run: ({ at, save }, { input }) => {
    const now = at.run({ input });
    if (now.kind !== "now") return now;

    const version = now.issue.version + 1;
    save.run({ input: { issue: { ...now.issue, state: input.state, version }, what: "moved" } });
    return { kind: "moved" as const, version };
  },
});

const renameIssue = operation({
  label: "issue.rename.do",
  input: issueApi["issue.rename"].input,
  depends: { at: atVersion, save: record },
  run: ({ at, save }, { input }) => {
    const now = at.run({ input });
    if (now.kind !== "now") return now;

    const version = now.issue.version + 1;
    save.run({ input: { issue: { ...now.issue, title: input.title, version }, what: "renamed" } });
    return { kind: "renamed" as const, version };
  },
});

/** Put a label on an issue, or take it off. Either way the issue gets a new version. */
const labelIssue = operation({
  label: "issue.label.do",
  input: issueApi["issue.label"].input,
  depends: { tags: labels.controller, at: atVersion, save: record },
  run: ({ tags, at, save }, { input }) => {
    const now = at.run({ input });
    if (now.kind !== "now") return now;

    const key = { teamId: input.teamId, id: input.id, name: input.name };
    if (input.on) tags.set(key);
    else tags.delete(key);
    const version = now.issue.version + 1;
    save.run({ input: { issue: { ...now.issue, version }, what: "labeled" } });
    return { kind: "labeled" as const, version };
  },
});

/** Assign an issue, or take its assignee off. The assignee must be a `member` of the team. */
const assignIssue = operation({
  label: "issue.assign.do",
  input: issueApi["issue.assign"].input,
  depends: { team: members.controller, at: atVersion, save: record },
  run: ({ team, at, save }, { input }) => {
    const now = at.run({ input });
    if (now.kind !== "now") return now;

    const { teamId, userId } = input;
    if (userId !== null && team.of({ teamId, userId }).get()?.role !== "member") {
      return { kind: "notAssignable" as const };
    }

    const version = now.issue.version + 1;
    const next = { ...now.issue, assignee: userId ?? undefined, version };
    save.run({ input: { issue: next, what: "assigned" } });
    return { kind: "assigned" as const, version };
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

/** Delete a team: each member of each of its parts goes. Its members go last. */
const deleteTeam = operation({
  label: "team.delete.do",
  input: issueApi["team.delete"].input,
  depends: {
    may: canChange,
    team: members.controller,
    list: issues.controller,
    shut: archived.controller,
    tags: labels.controller,
    log: events.controller,
  },
  run: ({ may, team, list, shut, tags, log }, { input }) => {
    const now = may.run({ input });
    if (now.kind !== "ok") return now;

    const part = { teamId: input.teamId };
    for (const { id, name } of tags.where(part).get()) tags.delete({ ...part, id, name });
    for (const { id, version } of log.where(part).get()) log.delete({ ...part, id, version });
    for (const { id } of list.where(part).get()) list.delete({ ...part, id });
    shut.delete(part);
    for (const { userId } of team.where(part).get()) team.delete({ ...part, userId });
    return { kind: "deleted" as const };
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
  "issue.assign": assignIssue,
  "team.archive": archiveTeam,
  "team.delete": deleteTeam,
} as const;
