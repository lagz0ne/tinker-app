import { serve } from "@tinkered/bun";
import { exits } from "@tinkered/cli/test";
import { capsule, createScope, data, operation } from "@tinkered/core";
import type { Observe, Scope } from "@tinkered/core";
import { makeTestClock, memory } from "@tinkered/core/testing";
import { afterAll, beforeEach, expect, onTestFinished, test } from "vite-plus/test";
import { z } from "zod";

import { issues } from "@/issues";
import { givenUp, issueOps, membersOnly, serverParts, signedIn } from "@/issues/ops.server";
import { signIn, whoMeta } from "@/issues/sign-in";
import { letter, type Letter } from "@/mail/letter";
import { mailProvider } from "@/mail/provider";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

/** ck12: every test server fills the given `mailProvider` slot and installs the app's
 * `serverParts`, as the TASK says. The provider is the test's own: it keeps each try and each letter sent in its cells,
 * at the scope where it runs. `down`: these addresses throw. `hangs`: these never answer (`*`:
 * every address). `fail`: the next tries throw. `slow`: each send takes that many ms. */
type Mode = { down: string[]; hangs: string[]; fail: number; slow: number };

const mode = data<Mode>({
  label: "test.mail.mode",
  initial: { down: [], hangs: [], fail: 0, slow: 0 },
});

const sentMail = data<Letter[]>({ label: "test.mail.sent", initial: [] });
const tried = data<{ to: string; at: number }[]>({ label: "test.mail.tries", initial: [] });

const setMode = operation({
  label: "test.mail.setMode",
  input: z.object({
    down: z.array(z.string()).optional(),
    hangs: z.array(z.string()).optional(),
    fail: z.number().optional(),
    slow: z.number().optional(),
  }),
  depends: { mode: mode.controller },
  run: ({ mode }, { input }) => mode.update((m) => ({ ...m, ...input })),
});

const sendMail = operation({
  label: "test.mail.send",
  input: letter,
  depends: { mode: mode.controller, sent: sentMail.controller, tries: tried.controller },
  run: async ({ mode, sent, tries }, { input, clock, signal }) => {
    tries.update((list) => [...list, { to: input.to, at: clock.currentTimeMillis() }]);

    const m = mode.get();
    const hit = (list: string[]) => list.includes("*") || list.includes(input.to);
    if (hit(m.hangs)) {
      return new Promise<void>((_, no) =>
        signal.addEventListener("abort", () => no(new Error("closed")), { once: true }),
      );
    }
    if (hit(m.down)) throw new Error("mail is down");
    if (m.fail > 0) {
      mode.set({ ...m, fail: m.fail - 1 });
      throw new Error("mail is down");
    }

    if (m.slow) await clock.sleep(m.slow, signal);
    sent.update((list) => [...list, input]);
  },
});

const testMail = capsule({
  label: "test.mail",
  exports: { send: sendMail, sent: sentMail, tries: tried, mode, setMode },
});

// The issue board as the cmds install it, over a real socket: the server serves each team's parts
// to its members and implements the api; each tab reads the board and calls the api. The `who`
// name in each message's meta stands in for sign-in. Both sides export their spans, so a test can follow one trace.

const serverSpans: Observe.Span[] = [];
const tabSpans: Observe.Span[] = [];

const backend = await createScope({
  observe: { export: (span) => void serverSpans.push(span) },
  capsules: [
    exits({ file: process.env.TINKER_EXITS }),
    issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
    issues.api({ implement: issueOps, onStart: [signedIn] }),
    testMail(),
    mailProvider({ provider: testMail.send }),
    ...serverParts,
    server.server({ path: "/rpc", services: [issues.board, issues.api] }),
  ],
}).ready;

const { bun, url } = listen(backend, [server.server]);
const tabs: Scope.Handle[] = [];

/** A tab signed in as `who`, its spans in `tabSpans`. */
const open = async (who: string) => {
  const scope = await createScope({
    observe: { export: (span) => void tabSpans.push(span) },
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      tab.client({ url: `${url}/rpc`, meta: whoMeta }),
      issues.board({ read: tab.client }),
      issues.api({ remote: tab.client }),
    ],
  }).ready;
  if (who) scope.run(signIn, { input: { name: who } });
  tabs.push(scope);
  return scope;
};

const [ana, bo, cy] = [await open("ana"), await open("bo"), await open("cy")];
let n = 0;

/** A fresh team that ana made and bo joined; cy is not in it. */
const team = async () => {
  const teamId = `T${++n}`;
  await ana.run(issues.api["team.create"], { input: { teamId } });
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "member" } });
  return teamId;
};

/** A tab's reader of one team's issues, kept in use: a keyed board serves only parts in use. */
const read = (scope: Scope.Handle, teamId: string) => {
  const reader = scope.resolve(issues.board.issues.where({ teamId }));
  reader.watch(() => undefined);
  return reader;
};

/** The state of a tab's part of one team's issues. */
const state = (scope: Scope.Handle, teamId: string) =>
  scope.resolve(issues.board.status(issues.board.issues.where({ teamId }))).get()?.status;

const until = async (ok: () => boolean) => {
  const end = Date.now() + 8000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(() => {
  serverSpans.length = tabSpans.length = 0;
});

afterAll(async () => {
  for (const scope of tabs) await scope.close();
  await bun.stop(true);
  await backend.close();
});

test("a team is made once; issue numbers count up with no gap", async () => {
  const teamId = await team();
  const again = await bo.run(issues.api["team.create"], { input: { teamId } });
  const add = (title: string) => ana.run(issues.api["issue.create"], { input: { teamId, title } });

  expect(again).toEqual({ kind: "exists", teamId });
  expect([await add("one"), await add("two"), await add("three")]).toEqual([
    { kind: "created", number: 1 },
    { kind: "created", number: 2 },
    { kind: "created", number: 3 },
  ]);
  // S2: the count is the team's own. A second team starts at 1 again.
  const other = await team();
  expect(
    await ana.run(issues.api["issue.create"], { input: { teamId: other, title: "one" } }),
  ).toEqual({ kind: "created", number: 1 });
});

// S1: `exists` is an answer, not a way in. A person outside the team who names its key is told
// that it exists, and stays outside.
test("a team that exists takes no new member from team.create", async () => {
  const teamId = await team();

  expect(await cy.run(issues.api["team.create"], { input: { teamId } })).toEqual({
    kind: "exists",
    teamId,
  });
  const inTeam = backend
    .resolve(issues.board.members)
    .get()
    .filter((m) => m.teamId === teamId)
    .map((m) => m.userId);
  expect(inTeam.toSorted()).toEqual(["ana", "bo"]);
  expect(await cy.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual({
    kind: "gone",
  });
});

test("a move on one tab lands on the other; a move from an old version answers stale", async () => {
  const teamId = await team();
  const seen = read(bo, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Drag me" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const move = { teamId, id, version: 1 };

  expect(await ana.run(issues.api["issue.move"], { input: { ...move, state: "doing" } })).toEqual({
    kind: "moved",
    version: 2,
  });
  await until(() => seen.get()[0]?.state === "doing");

  expect(await bo.run(issues.api["issue.move"], { input: { ...move, state: "done" } })).toEqual({
    kind: "stale",
    version: 2,
  });
  // A version the server never had is not the one it has: stale too.
  expect(
    await bo.run(issues.api["issue.move"], { input: { ...move, version: 9, state: "done" } }),
  ).toEqual({
    kind: "stale",
    version: 2,
  });
  // S3: a stale move changes nothing.
  expect(
    backend
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.id === id),
  ).toMatchObject({ state: "doing", version: 2 });
});

// S8: a rename names the version it saw, as a move does. A move and a rename count one version,
// so a rename after a move from the same old version is stale, and changes nothing.
test("a rename lands on the other tab; a rename from an old version answers stale", async () => {
  const teamId = await team();
  const seen = read(bo, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Typo hre" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const rename = (title: string, version: number) =>
    ana.run(issues.api["issue.rename"], { input: { teamId, id, version, title } });

  expect(await rename("Typo here", 1)).toEqual({ kind: "renamed", version: 2 });
  await until(() => seen.get()[0]?.title === "Typo here");
  expect(
    await bo.run(issues.api["issue.move"], { input: { teamId, id, version: 2, state: "todo" } }),
  ).toEqual({ kind: "moved", version: 3 });
  expect(await rename("Lost edit", 2)).toEqual({ kind: "stale", version: 3 });
  expect(
    backend
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.id === id),
  ).toMatchObject({ title: "Typo here", state: "todo", version: 3 });
});

// S9: an archived team keeps its issues for its members, and every change answers `archived`
// and writes nothing. A person outside the team gets `gone`, as before: the archive is not news
// to them. A second archive answers the same.
test("an archived team is read as before and takes no change", async () => {
  const teamId = await team();
  const seen = read(bo, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Keep me" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const shut = { kind: "archived" };

  expect(await cy.run(issues.api["team.archive"], { input: { teamId } })).toEqual({ kind: "gone" });
  expect(await ana.run(issues.api["team.archive"], { input: { teamId } })).toEqual(shut);
  expect(await bo.run(issues.api["team.archive"], { input: { teamId } })).toEqual(shut);
  expect(
    await bo.run(issues.api["team.add"], { input: { teamId, userId: "cy", role: "member" } }),
  ).toEqual(shut);
  expect(
    await bo.run(issues.api["issue.create"], { input: { teamId, title: "Too late" } }),
  ).toEqual(shut);
  expect(
    await bo.run(issues.api["issue.move"], { input: { teamId, id, version: 1, state: "done" } }),
  ).toEqual(shut);
  expect(
    await bo.run(issues.api["issue.rename"], { input: { teamId, id, version: 1, title: "x" } }),
  ).toEqual(shut);
  expect(await cy.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual({
    kind: "gone",
  });

  expect(
    backend
      .resolve(issues.board.issues)
      .get()
      .filter((i) => i.teamId === teamId),
  ).toMatchObject([{ title: "Keep me", state: "backlog", version: 1 }]);
  const inTeam = backend
    .resolve(issues.board.members)
    .get()
    .filter((m) => m.teamId === teamId)
    .map((m) => m.userId);
  expect(inTeam.toSorted()).toEqual(["ana", "bo"]);
  expect(state(bo, teamId)).toBe("ready");
  // Another team is not archived by this one.
  const other = await team();
  expect(
    await ana.run(issues.api["issue.create"], { input: { teamId: other, title: "Open" } }),
  ).toEqual({ kind: "created", number: 1 });
});

// S10: a viewer reads the team as a member does, and every change they ask answers `forbidden`
// and writes nothing. The role check comes after the member check and before the archive check.
test("a viewer reads the team and every change they ask answers forbidden", async () => {
  const teamId = await team();
  const dee = await open("dee");
  const added = await ana.run(issues.api["team.add"], {
    input: { teamId, userId: "dee", role: "viewer" },
  });
  expect(added).toEqual({ kind: "added" });
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Look only" } });
  const seen = read(dee, teamId);
  await until(() => seen.get().length === 1);
  const { id, version } = seen.get()[0]!;
  const no = { kind: "forbidden" };

  expect(
    await dee.run(issues.api["team.add"], { input: { teamId, userId: "cy", role: "member" } }),
  ).toEqual(no);
  expect(await dee.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual(no);
  expect(
    await dee.run(issues.api["issue.move"], { input: { teamId, id, version, state: "done" } }),
  ).toEqual(no);
  expect(
    await dee.run(issues.api["issue.rename"], { input: { teamId, id, version, title: "x" } }),
  ).toEqual(no);
  expect(await dee.run(issues.api["team.archive"], { input: { teamId } })).toEqual(no);
  // A viewer of an archived team is told `forbidden`, not `archived`.
  await ana.run(issues.api["team.archive"], { input: { teamId } });
  expect(await dee.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual(no);

  expect(
    backend
      .resolve(issues.board.issues)
      .get()
      .filter((i) => i.teamId === teamId),
  ).toMatchObject([{ title: "Look only", state: "backlog", version: 1 }]);
  const inTeam = backend
    .resolve(issues.board.members)
    .get()
    .filter((m) => m.teamId === teamId)
    .map((m) => `${m.userId} ${m.role}`);
  expect(inTeam.toSorted()).toEqual(["ana member", "bo member", "dee viewer"]);
  expect(state(dee, teamId)).toBe("ready");
});

/** A tab's reader of one team's labels, kept in use. */
const tagsOf = (scope: Scope.Handle, teamId: string) => {
  const reader = scope.resolve(issues.board.labels.where({ teamId }));
  reader.watch(() => undefined);
  return reader;
};

// S11: a label change is a change of the issue. It names the version it saw, as a move does, and
// counts one version. The other tab sees the label come and go.
test("a label put on one tab shows on the other; taking it off removes it; each counts a version", async () => {
  const teamId = await team();
  const seen = read(bo, teamId);
  const tags = tagsOf(bo, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Crash" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const label = (name: string, on: boolean, version: number) =>
    ana.run(issues.api["issue.label"], { input: { teamId, id, version, name, on } });

  expect(await label("Bug", true, 1)).toEqual({ kind: "labeled", version: 2 });
  expect(await label("ui", true, 2)).toEqual({ kind: "labeled", version: 3 });
  await until(() => tags.get().length === 2);
  expect(
    tags
      .get()
      .map((t) => `${t.id === id} ${t.name}`)
      .toSorted(),
  ).toEqual(["true bug", "true ui"]);
  await until(() => seen.get()[0]?.version === 3);

  expect(await label("bug", false, 3)).toEqual({ kind: "labeled", version: 4 });
  await until(() => tags.get().length === 1);
  expect(tags.get()[0]?.name).toBe("ui");
  // A label change, a move and a rename count one version: an old one is stale and writes nothing.
  expect(await label("p1", true, 3)).toEqual({ kind: "stale", version: 4 });
  expect(
    await bo.run(issues.api["issue.move"], { input: { teamId, id, version: 4, state: "todo" } }),
  ).toEqual({ kind: "moved", version: 5 });
  expect(await label("p1", true, 4)).toEqual({ kind: "stale", version: 5 });
  expect(
    backend
      .resolve(issues.board.labels)
      .get()
      .filter((t) => t.teamId === teamId)
      .map((t) => t.name),
  ).toEqual(["ui"]);
});

// S11: a label change is a change, so it answers as every change does: `gone` outside the team
// and for an issue that is not there, `forbidden` for a viewer, `archived` for an archived team.
test("a label change answers gone, forbidden and archived as every change does, and writes nothing", async () => {
  const teamId = await team();
  const dee = await open("dee");
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "dee", role: "viewer" } });
  const seen = read(ana, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Ours" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const tag = { teamId, id, version: 1, name: "bug", on: true };

  expect(await cy.run(issues.api["issue.label"], { input: tag })).toEqual({ kind: "gone" });
  expect(await ana.run(issues.api["issue.label"], { input: { ...tag, id: "none" } })).toEqual({
    kind: "gone",
  });
  expect(await dee.run(issues.api["issue.label"], { input: tag })).toEqual({ kind: "forbidden" });
  await ana.run(issues.api["team.archive"], { input: { teamId } });
  expect(await bo.run(issues.api["issue.label"], { input: tag })).toEqual({ kind: "archived" });

  expect(
    backend
      .resolve(issues.board.labels)
      .get()
      .filter((t) => t.teamId === teamId),
  ).toEqual([]);
  expect(
    backend
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.id === id),
  ).toMatchObject({ version: 1 });
});

/** A tab's reader of its own places in every team, kept in use. */
const placesOf = (scope: Scope.Handle, userId: string) => {
  const reader = scope.resolve(issues.board.members.where({ userId }));
  reader.watch(() => undefined);
  return reader;
};

// S12: an assignment is a change of the issue. It names the version it saw, counts one version,
// and the assignee must be a `member` of the team. `userId: null` takes the assignee off.
test("an issue is assigned to a member and taken off; anyone else is not assignable", async () => {
  const teamId = await team();
  const seen = read(bo, teamId);
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "dee", role: "viewer" } });
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Fix it" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const assign = (userId: string | null, version: number) =>
    ana.run(issues.api["issue.assign"], { input: { teamId, id, version, userId } });

  expect(await assign("bo", 1)).toEqual({ kind: "assigned", version: 2 });
  await until(() => seen.get()[0]?.assignee === "bo");
  // A viewer, and a person outside the team, cannot take an issue.
  expect(await assign("dee", 2)).toEqual({ kind: "notAssignable" });
  expect(await assign("cy", 2)).toEqual({ kind: "notAssignable" });
  expect(await assign("ana", 1)).toEqual({ kind: "stale", version: 2 });
  expect(await assign(null, 2)).toEqual({ kind: "assigned", version: 3 });
  await until(() => seen.get()[0]?.version === 3);
  expect(seen.get()[0]?.assignee).toBeUndefined();
  expect(
    await bo.run(issues.api["issue.rename"], { input: { teamId, id, version: 3, title: "Fixed" } }),
  ).toEqual({ kind: "renamed", version: 4 });
});

// S12: an assignment answers as every change does.
test("an assignment answers gone, forbidden and archived as every change does, and writes nothing", async () => {
  const teamId = await team();
  const dee = await open("dee");
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "dee", role: "viewer" } });
  const seen = read(ana, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Ours" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const to = { teamId, id, version: 1, userId: "bo" };

  expect(await cy.run(issues.api["issue.assign"], { input: to })).toEqual({ kind: "gone" });
  expect(await ana.run(issues.api["issue.assign"], { input: { ...to, id: "none" } })).toEqual({
    kind: "gone",
  });
  expect(await dee.run(issues.api["issue.assign"], { input: to })).toEqual({ kind: "forbidden" });
  await ana.run(issues.api["team.archive"], { input: { teamId } });
  expect(await bo.run(issues.api["issue.assign"], { input: to })).toEqual({ kind: "archived" });

  expect(
    backend
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.id === id),
  ).toEqual(expect.not.objectContaining({ assignee: expect.anything() }));
});

// S13: a person reads their own places in every team, live: a team that adds them shows at once.
// Nobody else reads them.
test("a person reads their own teams, live; another person's teams are refused", async () => {
  const first = await team();
  const eve = await open("eve");
  const mine = placesOf(eve, "eve");
  await ana.run(issues.api["team.add"], {
    input: { teamId: first, userId: "eve", role: "member" },
  });
  await until(() => mine.get().length === 1);
  const second = await team();
  await ana.run(issues.api["team.add"], {
    input: { teamId: second, userId: "eve", role: "viewer" },
  });
  await until(() => mine.get().length === 2);
  expect(
    mine
      .get()
      .map((m) => `${m.teamId} ${m.role}`)
      .toSorted(),
  ).toEqual([`${first} member`, `${second} viewer`]);

  const peek = placesOf(cy, "eve");
  const status = () =>
    cy.resolve(issues.board.status(issues.board.members.where({ userId: "eve" }))).get();
  await until(() => status()?.status === "fault");
  expect(status()).toMatchObject({ fault: { fault: "refused" } });
  expect(peek.get()).toEqual([]);
});

/** The events of one team on the server, as `version what by` per issue id. */
const eventsOf = (teamId: string) =>
  backend
    .resolve(issues.board.events)
    .get()
    .filter((e) => e.teamId === teamId)
    .toSorted((a, b) => a.version - b.version)
    .map((e) => `${e.id} ${e.version} ${e.what} ${e.by}`);

// S14: each change of an issue that succeeds leaves one event, at the issue's new version, with
// the caller and what changed. The other tabs see it.
test("every change of an issue leaves one event at its new version, with who and what", async () => {
  const teamId = await team();
  const seen = read(bo, teamId);
  const log = bo.resolve(issues.board.events.where({ teamId }));
  log.watch(() => undefined);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Slow" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const at = { teamId, id };

  await bo.run(issues.api["issue.move"], { input: { ...at, version: 1, state: "doing" } });
  await ana.run(issues.api["issue.rename"], { input: { ...at, version: 2, title: "Too slow" } });
  await bo.run(issues.api["issue.label"], { input: { ...at, version: 3, name: "perf", on: true } });
  await bo.run(issues.api["issue.label"], {
    input: { ...at, version: 4, name: "perf", on: false },
  });
  await ana.run(issues.api["issue.assign"], { input: { ...at, version: 5, userId: "bo" } });

  expect(eventsOf(teamId)).toEqual([
    `${id} 1 created ana`,
    `${id} 2 moved bo`,
    `${id} 3 renamed ana`,
    `${id} 4 labeled bo`,
    `${id} 5 labeled bo`,
    `${id} 6 assigned ana`,
  ]);
  await until(() => log.get().length === 6);
});

// S14: an answer that is not a success leaves no event; nor does a change that is not of an
// issue (a member added, the team archived).
test("an answer that is not a success leaves no event, nor does a change of the team", async () => {
  const teamId = await team();
  const dee = await open("dee");
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "dee", role: "viewer" } });
  const seen = read(ana, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "One" } });
  await until(() => seen.get().length === 1);
  const { id } = seen.get()[0]!;
  const at = { teamId, id };

  await ana.run(issues.api["issue.move"], { input: { ...at, version: 9, state: "done" } });
  await ana.run(issues.api["issue.assign"], { input: { ...at, version: 1, userId: "dee" } });
  await dee.run(issues.api["issue.rename"], { input: { ...at, version: 1, title: "x" } });
  await cy.run(issues.api["issue.label"], { input: { ...at, version: 1, name: "x", on: true } });
  await ana.run(issues.api["team.archive"], { input: { teamId } });
  await bo.run(issues.api["issue.create"], { input: { teamId, title: "Two" } });

  expect(eventsOf(teamId)).toEqual([`${id} 1 created ana`]);
});

/** What is left of one team on the server, in every part. */
const leftOf = (teamId: string) => {
  const mine = <T extends { teamId: string }>(list: readonly T[]) =>
    list.filter((m) => m.teamId === teamId).length;
  return [
    mine(backend.resolve(issues.board.members).get()),
    mine(backend.resolve(issues.board.issues).get()),
    mine(backend.resolve(issues.board.archived).get()),
    mine(backend.resolve(issues.board.labels).get()),
    mine(backend.resolve(issues.board.events).get()),
  ];
};

// S15 (ck11): a delete answers at once. The members go at once, so the team is hidden at once;
// the other parts go later, at most 100 a second. The key is free again only once they are gone.
// The server here is the board, the api and the app's `serverParts`, on a test clock: the tests
// name no op. They delete, move the clock, and look at the server's cells.

/** A server with the app's server parts and a test clock (mail up), over `memory`. `pass(ms)`
 * moves the clock in 100 ms steps, letting work run. `big(teamId, n)`: ana makes the team, adds
 * bo, makes `n` issues with a label each, and archives it. */
const sweepWorld = async () => {
  const clock = makeTestClock({ now: 5_000_000 });
  const server = await createScope({
    clock,
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      testMail(),
      mailProvider({ provider: testMail.send }),
      ...serverParts,
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const tabOf = async (name: string) => {
    const scope = await createScope({
      capsules: [
        exits({ file: process.env.TINKER_EXITS }),
        memory.client({ peer: server, meta: whoMeta }),
        issues.board({ read: memory.client }),
        issues.api({ remote: memory.client }),
      ],
    }).ready;
    scope.run(signIn, { input: { name } });
    return scope;
  };

  const [ana, bo, cy] = [await tabOf("ana"), await tabOf("bo"), await tabOf("cy")];
  onTestFinished(async () => {
    for (const t of [ana, bo, cy]) await t.close();
    await server.close();
  });

  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  /** Each part of a team on the server: members, then the other parts (issues, archive mark,
   * labels, events). */
  const parts = (teamId: string) => {
    const mine = <T extends { teamId: string }>(list: readonly T[]) =>
      list.filter((m) => m.teamId === teamId);
    return {
      members: mine(server.resolve(issues.board.members).get()),
      other: [
        ...mine(server.resolve(issues.board.issues).get()),
        ...mine(server.resolve(issues.board.archived).get()),
        ...mine(server.resolve(issues.board.labels).get()),
        ...mine(server.resolve(issues.board.events).get()),
      ],
    };
  };
  const big = async (teamId: string, n: number) => {
    await ana.run(issues.api["team.create"], { input: { teamId } });
    await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "member" } });
    for (let k = 0; k < n; k++) {
      await ana.run(issues.api["issue.create"], { input: { teamId, title: `t${k}` } });
    }

    const made = server
      .resolve(issues.board.issues)
      .get()
      .filter((i) => i.teamId === teamId);
    for (const { id } of made) {
      const input = { teamId, id, version: 1, name: "x", on: true };
      await ana.run(issues.api["issue.label"], { input });
    }

    await ana.run(issues.api["team.archive"], { input: { teamId } });
    // n issues, n labels, 2n events, the archive mark.
    expect(parts(teamId).other).toHaveLength(4 * n + 1);
  };
  return { server, ana, bo, cy, pass, parts, big };
};

test("a delete answers at once; its members go at once, its other parts later, 100 a second at most", async () => {
  const { bo, cy, pass, parts, big } = await sweepWorld();
  await big("BIG", 40);
  const seen = bo.resolve(issues.board.issues.where({ teamId: "BIG" }));
  seen.watch(() => undefined);
  const places = bo.resolve(issues.board.members.where({ userId: "bo" }));
  places.watch(() => undefined);
  await until(() => seen.get().length === 40 && places.get().some((p) => p.teamId === "BIG"));

  expect(await bo.run(issues.api["team.delete"], { input: { teamId: "BIG" } })).toEqual({
    kind: "deleted",
  });
  expect(parts("BIG").members).toEqual([]);
  expect(parts("BIG").other.length).toBeGreaterThanOrEqual(161 - 100);
  // The tab that reads the team is told it is not in it; its own list drops the team.
  await until(
    () =>
      bo.resolve(issues.board.status(issues.board.issues.where({ teamId: "BIG" }))).get()
        ?.status === "fault",
  );
  await until(() => !places.get().some((p) => p.teamId === "BIG"));
  await pass(1_000);
  expect(parts("BIG").other.length).toBeGreaterThanOrEqual(161 - 200);

  await pass(60_000);
  expect(parts("BIG")).toEqual({ members: [], other: [] });
  // The key is free again: a team made with it starts empty.
  expect(await cy.run(issues.api["team.create"], { input: { teamId: "BIG" } })).toEqual({
    kind: "created",
    teamId: "BIG",
  });
  expect(
    await cy.run(issues.api["issue.create"], { input: { teamId: "BIG", title: "New" } }),
  ).toEqual({
    kind: "created",
    number: 1,
  });
  expect(parts("BIG").members.map((m) => m.userId)).toEqual(["cy"]);
  expect(parts("BIG").other).toHaveLength(2);
}, 30_000);

test("between the halves: the team is hidden, its key is not free, another team is not touched", async () => {
  const { server, ana, bo, cy, pass, parts, big } = await sweepWorld();
  await big("HALF", 40);
  await big("KEEP", 3);
  const keep = parts("KEEP");
  const [old] = server
    .resolve(issues.board.issues)
    .get()
    .filter((i) => i.teamId === "HALF");

  expect(await ana.run(issues.api["team.delete"], { input: { teamId: "HALF" } })).toEqual({
    kind: "deleted",
  });
  const hidden = async () => {
    const teamId = "HALF";

    expect(await bo.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual({
      kind: "gone",
    });
    expect(
      await bo.run(issues.api["team.add"], { input: { teamId, userId: "dee", role: "member" } }),
    ).toEqual({ kind: "gone" });
    expect(
      await ana.run(issues.api["issue.move"], {
        input: { teamId, id: old?.id ?? "", version: 2, state: "done" },
      }),
    ).toEqual({ kind: "gone" });
    expect(await ana.run(issues.api["team.archive"], { input: { teamId } })).toEqual({
      kind: "gone",
    });
    expect(await ana.run(issues.api["team.delete"], { input: { teamId } })).toEqual({
      kind: "gone",
    });
    // The key is not free yet: `exists`, and nobody joins.
    expect(await cy.run(issues.api["team.create"], { input: { teamId } })).toEqual({
      kind: "exists",
      teamId,
    });
    expect(parts(teamId).members).toEqual([]);
    expect(await cy.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual({
      kind: "gone",
    });

    expect(parts("KEEP")).toEqual(keep);
  };

  await hidden();
  await pass(900);
  // Half way (what-if: before the 1 s mark): some parts are gone, some are left.
  expect(parts("HALF").other.length).toBeGreaterThan(0);
  await hidden();
  await pass(60_000);
  expect(parts("HALF")).toEqual({ members: [], other: [] });
  expect(parts("KEEP")).toEqual(keep);
}, 30_000);

test("delivered twice: two deletes at once, a retried delete, and a key made again keeps its parts", async () => {
  const { ana, bo, pass, parts, big } = await sweepWorld();
  await big("TWICE", 10);
  await big("KEEP", 2);
  const keep = parts("KEEP");

  const both = await Promise.all([
    ana.run(issues.api["team.delete"], { input: { teamId: "TWICE" } }),
    bo.run(issues.api["team.delete"], { input: { teamId: "TWICE" } }),
  ]);
  expect(both.map((a) => a.kind).toSorted()).toEqual(["deleted", "gone"]);
  expect(await ana.run(issues.api["team.delete"], { input: { teamId: "TWICE" } })).toEqual({
    kind: "gone",
  });
  await pass(60_000);
  expect(parts("TWICE")).toEqual({ members: [], other: [] });

  // Made again: its new parts stay, however long the server runs.
  await big("TWICE", 3);
  const fresh = parts("TWICE");
  await pass(120_000);
  expect(parts("TWICE")).toEqual(fresh);
  // Deleted again: only then do they go.
  expect(await ana.run(issues.api["team.delete"], { input: { teamId: "TWICE" } })).toEqual({
    kind: "deleted",
  });
  await pass(60_000);
  expect(parts("TWICE")).toEqual({ members: [], other: [] });
  expect(parts("KEEP")).toEqual(keep);
}, 30_000);

test("stopped half way: the server closes while the parts go, and the close ends at once", async () => {
  const { server, ana, pass, parts, big } = await sweepWorld();
  await big("STOP", 40);

  await ana.run(issues.api["team.delete"], { input: { teamId: "STOP" } });
  await pass(900);
  expect(parts("STOP").other.length).toBeGreaterThan(0);
  // No time passes from here: a close that waits on the clock never ends.
  const end = await Promise.race([
    server.close().then(() => "closed"),
    new Promise((r) => setTimeout(() => r("still open after 3 s"), 3000)),
  ]);
  expect(end).toBe("closed");
}, 30_000);

// S16 (ck9): an assignee is always a `member`. A person made a viewer is taken off each issue of
// that team. Each is a change of the issue: one new version, one `assigned` event by the caller.
test("a member made a viewer is taken off the team's issues: one version and one event each", async () => {
  const teamId = await team();
  const other = await team();
  const seen = read(bo, teamId);
  const made = async (t: string, title: string, userId: string) => {
    await ana.run(issues.api["issue.create"], { input: { teamId: t, title } });
    const it = backend
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.teamId === t && i.title === title)!;
    await ana.run(issues.api["issue.assign"], {
      input: { teamId: t, id: it.id, version: 1, userId },
    });
    return it.id;
  };
  const [one, two, hers, elsewhere] = [
    await made(teamId, "One", "bo"),
    await made(teamId, "Two", "bo"),
    await made(teamId, "Hers", "ana"),
    await made(other, "Elsewhere", "bo"),
  ];
  await until(() => seen.get().filter((i) => i.assignee === "bo").length === 2);
  const issueOf = (id: string) =>
    backend
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.id === id);
  const eventsOf = (id: string) =>
    backend
      .resolve(issues.board.events)
      .get()
      .filter((e) => e.id === id)
      .map((e) => [e.version, e.by, e.what])
      .toSorted((x, y) => Number(x[0]) - Number(y[0]));

  expect(
    await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "viewer" } }),
  ).toEqual({ kind: "added" });
  for (const id of [one, two]) {
    expect(issueOf(id)).toMatchObject({ version: 3 });
    expect(issueOf(id)?.assignee).toBeUndefined();
    expect(eventsOf(id)).toEqual([
      [1, "ana", "created"],
      [2, "ana", "assigned"],
      [3, "ana", "assigned"],
    ]);
  }
  // Another person's issue, and bo's issue in another team, do not change.
  expect(issueOf(hers)).toMatchObject({ assignee: "ana", version: 2 });
  expect(issueOf(elsewhere)).toMatchObject({ assignee: "bo", version: 2 });
  expect(eventsOf(elsewhere)).toHaveLength(2);
  expect(
    backend
      .resolve(issues.board.members)
      .get()
      .find((m) => m.teamId === teamId && m.userId === "bo")?.role,
  ).toBe("viewer");
  // The other tab sees it, and the issue stays unassignable to the viewer.
  await until(() => seen.get().every((i) => i.assignee !== "bo"));
  expect(
    await ana.run(issues.api["issue.assign"], {
      input: { teamId, id: one, version: 3, userId: "bo" },
    }),
  ).toEqual({ kind: "notAssignable" });
});

// S16: a role change that leaves the person a member, a viewer added new, or a viewer made a
// member changes no issue and leaves no event.
test("a role that stays member, or a viewer added or promoted, changes no issue", async () => {
  const teamId = await team();
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Kept" } });
  const [it] = backend
    .resolve(issues.board.issues)
    .get()
    .filter((i) => i.teamId === teamId);
  await ana.run(issues.api["issue.assign"], {
    input: { teamId, id: it!.id, version: 1, userId: "bo" },
  });
  const snap = () => ({
    issues: backend
      .resolve(issues.board.issues)
      .get()
      .filter((i) => i.teamId === teamId),
    events: backend
      .resolve(issues.board.events)
      .get()
      .filter((e) => e.teamId === teamId).length,
  });
  const before = snap();
  const add = (userId: string, role: "member" | "viewer") =>
    ana.run(issues.api["team.add"], { input: { teamId, userId, role } });

  expect(await add("bo", "member")).toEqual({ kind: "added" });
  expect(await add("cy", "viewer")).toEqual({ kind: "added" });
  expect(await add("cy", "viewer")).toEqual({ kind: "added" });
  expect(await add("cy", "member")).toEqual({ kind: "added" });
  expect(snap()).toEqual(before);
});

// S16 and R4: a role change that is refused takes nobody off: gone, forbidden, archived.
test("a refused role change takes nobody off an issue", async () => {
  const teamId = await team();
  const dee = await open("dee");
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "dee", role: "viewer" } });
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Held" } });
  const [it] = backend
    .resolve(issues.board.issues)
    .get()
    .filter((i) => i.teamId === teamId);
  await ana.run(issues.api["issue.assign"], {
    input: { teamId, id: it!.id, version: 1, userId: "bo" },
  });
  const snap = () => [
    backend
      .resolve(issues.board.issues)
      .get()
      .filter((i) => i.teamId === teamId),
    backend
      .resolve(issues.board.events)
      .get()
      .filter((e) => e.teamId === teamId).length,
  ];
  const before = snap();
  const demote = { input: { teamId, userId: "bo", role: "viewer" as const } };

  expect(await cy.run(issues.api["team.add"], demote)).toEqual({ kind: "gone" });
  expect(await dee.run(issues.api["team.add"], demote)).toEqual({ kind: "forbidden" });
  await ana.run(issues.api["team.archive"], { input: { teamId } });
  expect(await ana.run(issues.api["team.add"], demote)).toEqual({ kind: "archived" });
  expect(snap()).toEqual(before);
});

// S15: a delete answers `gone` outside the team and `forbidden` to a viewer, and writes nothing.
test("a delete answers gone outside the team and forbidden to a viewer, and writes nothing", async () => {
  const teamId = await team();
  const dee = await open("dee");
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "dee", role: "viewer" } });
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Stay" } });

  expect(await cy.run(issues.api["team.delete"], { input: { teamId } })).toEqual({ kind: "gone" });
  expect(await dee.run(issues.api["team.delete"], { input: { teamId } })).toEqual({
    kind: "forbidden",
  });
  expect(leftOf(teamId)).toEqual([3, 1, 0, 0, 1]);
  // Another team is not deleted by this one.
  const other = await team();
  await ana.run(issues.api["team.delete"], { input: { teamId } });
  expect(leftOf(other)).toEqual([2, 0, 0, 0, 0]);
});

test("a tab with no `who` is refused; so is a member of no team, on calls and on reads", async () => {
  const teamId = await team();
  const peek = read(cy, teamId);
  const ghost = await open("");
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Secret" } });

  expect(await cy.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual({
    kind: "gone",
  });
  const refused = await ghost
    .run(issues.api["team.create"], { input: { teamId: "NOPE" } })
    .catch((e: unknown) => e);
  expect(issues.api.fault.is(refused) && refused.fault).toBe("refused");
  await until(() => state(cy, teamId) === "fault");
  expect(peek.get()).toEqual([]);
});

/** Reads each part of one team on a tab; answers a function that gives each part's fault. */
const faultsOf = (scope: Scope.Handle, teamId: string) => {
  const parts = [
    issues.board.members.where({ teamId }),
    issues.board.issues.where({ teamId }),
    issues.board.archived.where({ teamId }),
    issues.board.labels.where({ teamId }),
    issues.board.events.where({ teamId }),
  ] as const;
  for (const part of parts) scope.resolve(part).watch(() => undefined);

  return () =>
    parts.map((part) => {
      const now = scope.resolve(issues.board.status(part)).get();
      return now?.status === "fault" ? now.fault : undefined;
    });
};

// S5, each part of a team: members, issues, the archive mark, the labels and the events. A read from outside the team is refused
// with the team in the payload; a read with no `who` is refused too.
test("every part of a team is refused to a person outside it, and to a tab with no `who`", async () => {
  const teamId = await team();
  const seen = read(ana, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Ours" } });
  await until(() => seen.get().length === 1);
  const outside = faultsOf(cy, teamId);
  const nobody = faultsOf(await open(""), teamId);
  await until(() => [...outside(), ...nobody()].every(Boolean));

  const refused = { fault: "refused", payload: { notMember: teamId } };
  expect(outside()).toMatchObject([refused, refused, refused, refused, refused]);
  expect(nobody().map((fault) => fault?.fault)).toEqual([
    "refused",
    "refused",
    "refused",
    "refused",
    "refused",
  ]);
});

// S5, each call that names a team: the `gone` answer is reached once from outside the team and,
// where the call names an issue, once for an issue that is not there. Nothing is written.
test("every call that names a team answers gone to a person outside it, and writes nothing", async () => {
  const teamId = await team();
  const seen = read(ana, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Ours" } });
  await until(() => seen.get().length === 1);
  const { id, version } = seen.get()[0]!;
  const gone = { kind: "gone" };

  expect(
    await cy.run(issues.api["team.add"], { input: { teamId, userId: "cy", role: "member" } }),
  ).toEqual(gone);
  expect(
    await cy.run(issues.api["issue.move"], { input: { teamId, id, version, state: "done" } }),
  ).toEqual(gone);
  expect(
    await cy.run(issues.api["issue.rename"], { input: { teamId, id, version, title: "x" } }),
  ).toEqual(gone);
  serverSpans.length = 0;
  expect(
    await ana.run(issues.api["issue.move"], {
      input: { teamId, id: "none", version: 1, state: "done" },
    }),
  ).toEqual(gone);
  expect(
    await ana.run(issues.api["issue.rename"], {
      input: { teamId, id: "none", version: 1, title: "x" },
    }),
  ).toEqual(gone);
  // S7: each call runs the member check, also when its issue is not there.
  await until(() => serverSpans.filter((span) => span.name === "issues.inTeam").length === 2);
  // An issue of another team is not an issue of this one.
  const other = await team();
  expect(
    await ana.run(issues.api["issue.rename"], {
      input: { teamId: other, id, version: 1, title: "x" },
    }),
  ).toEqual(gone);

  const members = backend.resolve(issues.board.members).get();
  expect(members.some((m) => m.teamId === teamId && m.userId === "cy")).toBe(false);
  expect(
    backend
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.id === id),
  ).toMatchObject({ state: "backlog", title: "Ours" });
});

// A refused part is the server's answer: the tab does not ask again by itself (Core 0.17.4,
// ADR 0139). The page's "Try again" is an `invalidate` of the part, as a query's `refetch`.
test("a person added while their tab is open sees the team when they try again", async () => {
  const teamId = await team();
  const peek = read(cy, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Welcome" } });
  await until(() => state(cy, teamId) === "fault");

  await ana.run(issues.api["team.add"], { input: { teamId, userId: "cy", role: "member" } });
  await cy.run(issues.board.invalidate, { input: { issues: { teamId } } });
  await until(() => peek.get().length === 1);

  expect(state(cy, teamId)).toBe("ready");
});

/** The one span of this name; its trace id. */
const one = (spans: Observe.Span[], name: string) => {
  const found = spans.filter((span) => span.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
};

// One move, followed across both tabs and the server, as OTel messaging: tab A's call, the
// server's op and its `remoteData.send` (the producer) are one trace. The signal carries that
// send; tab B's ask runs under `remoteData.receive` (the consumer), a trace of its own with a
// link to the send. So a move and every read it caused join up (Core 0.17.3).
test("one move: one trace from tab A to the server's send; tab B's ask links to it", async () => {
  const teamId = await team();
  const seen = read(bo, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Trace me" } });
  await until(() => seen.get().length === 1);
  const id = seen.get()[0]!.id;
  serverSpans.length = tabSpans.length = 0;

  await ana.run(issues.api["issue.move"], { input: { teamId, id, version: 1, state: "done" } });
  await until(() => seen.get()[0]?.state === "done");
  await until(() => serverSpans.some((s) => s.name === "remoteData.answer"));

  const names = (spans: Observe.Span[], traceId: string) =>
    spans
      .filter((s) => s.traceId === traceId)
      .map((s) => s.name)
      .toSorted();
  const call = one(tabSpans, "issue.move").traceId;
  // A move writes the issue and its event: the send that carries the issue is the one tab B asks
  // after.
  const sends = serverSpans.filter(
    (s) => s.name === "remoteData.send" && s.attributes["messaging.destination.name"] === "issues",
  );
  expect(sends).toHaveLength(1);
  const send = sends[0]!;
  const receive = one(tabSpans, "remoteData.receive");
  const ask = receive.traceId;

  expect(names(tabSpans, call)).toEqual(["issue.move", "issues.whoMeta", "ws.call", "ws.send"]);
  // Kit: the ops the TASK names must be in the trace. An op of the writer's own that a call
  // runs (a shared check, for example) may be there too.
  expect(names(serverSpans, call)).toEqual(
    expect.arrayContaining([
      "issue.move.do",
      "issues.inTeam",
      "issues.signedIn",
      "remoteData.send",
      "rpc.answer",
      "ws.serve",
    ]),
  );
  expect(send.traceId).toBe(call);
  // Tab B's ask is its own trace, as an OTel consumer: it links to the server's send.
  const link = receive.events.find((e) => e.name === "link")?.attributes?.traceparent;
  expect(link).toBe(`00-${call}-${send.spanId}-01`);
  expect(names(tabSpans, ask)).toEqual([
    "issues.ask",
    "issues.whoMeta",
    "remoteData.receive",
    "ws.call",
    "ws.send",
  ]);
  // Kit: as for the call, an op of the writer's own that the read hook runs may be there too.
  expect(names(serverSpans, ask)).toEqual(
    expect.arrayContaining([
      "issues.inTeam",
      "issues.membersOnly",
      "issues.signedIn",
      "remoteData.answer",
      "remoteData.ask",
      "ws.serve",
    ]),
  );
});

// S17 (ck10b, ck12): a person added to a team gets one welcome mail. The call never waits for
// mail. The server is the board, the api, and the app's own `serverParts`; the `mailProvider`
// slot holds the test's `testMail`, and time is a test clock. The tests name no op of the app: they add
// people, move the clock, and read the provider's cells and `givenUp` at the server's root.

/** A server with the app's server parts, the test provider and a test clock, over `memory`, and
 * ana's tab. Ana made `MAIL`. `pass(ms)` moves the clock in 100 ms steps, letting work run. */
const mailWorld = async () => {
  const clock = makeTestClock({ now: 1_000_000 });

  const server = await createScope({
    clock,
    capsules: [
      exits({ file: process.env.TINKER_EXITS }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      testMail(),
      mailProvider({ provider: testMail.send }),
      ...serverParts,
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const tabOf = async (name: string) => {
    const scope = await createScope({
      capsules: [
        exits({ file: process.env.TINKER_EXITS }),
        memory.client({ peer: server, meta: whoMeta }),
        issues.board({ read: memory.client }),
        issues.api({ remote: memory.client }),
      ],
    }).ready;
    scope.run(signIn, { input: { name } });
    return scope;
  };

  const ana = await tabOf("ana");
  let open = true;
  onTestFinished(async () => {
    await ana.close();
    if (open) await server.close();
  });
  await ana.run(issues.api["team.create"], { input: { teamId: "MAIL" } });

  const add = (userId: string, role: "member" | "viewer" = "member") =>
    ana.run(issues.api["team.add"], { input: { teamId: "MAIL", userId, role } });
  const pass = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  /** The provider's state at the root: what it sent, each try, and the letters given up. */
  const fake = {
    set: (input: Partial<Mode>) => server.run(testMail.setMode, { input }),
    sent: () => server.resolve(testMail.sent).get(),
    tries: (to?: string) =>
      server
        .resolve(testMail.tries)
        .get()
        .filter((t) => to === undefined || t.to === to),
    givenUp: () => server.resolve(givenUp).get(),
  };
  const close = async () => {
    open = false;
    return Promise.race([
      server.close().then(() => "closed"),
      new Promise((r) => setTimeout(() => r("still open after 3 s"), 3000)),
    ]);
  };
  return { fake, server, ana, add, tabOf, pass, close };
};

/** The gaps between one address's tries, on the scope clock. */
const gaps = (at: readonly { at: number }[]) =>
  at.slice(1).map((t, i) => t.at - (at[i]?.at ?? t.at));

test("a person added gets one welcome mail; a role change or a refused add sends none", async () => {
  const { fake, add, ana, tabOf, pass } = await mailWorld();

  expect(await add("bo")).toEqual({ kind: "added" });
  await pass(2_000);
  expect(fake.sent().map((m) => [m.to, m.subject])).toEqual([["bo", "Welcome to MAIL"]]);
  // A role change of a person in the team is not a welcome.
  expect(await add("bo", "viewer")).toEqual({ kind: "added" });
  expect(await add("bo", "member")).toEqual({ kind: "added" });
  expect(await add("cy", "viewer")).toEqual({ kind: "added" });
  // Refused adds send nothing: gone, forbidden, archived.
  const cy = await tabOf("cy");
  const dee = await tabOf("dee");
  const tryAdd = { input: { teamId: "MAIL", userId: "eve", role: "member" as const } };
  expect(await dee.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "gone" });
  expect(await cy.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "forbidden" });
  await ana.run(issues.api["team.archive"], { input: { teamId: "MAIL" } });
  expect(await ana.run(issues.api["team.add"], tryAdd)).toEqual({ kind: "archived" });
  await pass(5_000);
  expect(fake.sent().map((m) => [m.to, m.subject])).toEqual([
    ["bo", "Welcome to MAIL"],
    ["cy", "Welcome to MAIL"],
  ]);
  expect(fake.tries()).toHaveLength(2);
  expect(fake.givenUp()).toEqual([]);
  await cy.close();
  await dee.close();
});

test("mail is down once: the add answers, and the mail arrives once mail is back", async () => {
  const { fake, add, pass } = await mailWorld();
  await fake.set({ fail: 1 });

  expect(await add("bo")).toEqual({ kind: "added" });
  await pass(60_000);
  expect(fake.sent().map((m) => m.to)).toEqual(["bo"]);
  expect(fake.tries()).toHaveLength(2);
  await pass(60_000);
  expect(fake.sent().map((m) => m.to)).toEqual(["bo"]);
});

test("mail never answers: the add answers at once; the mail is tried again after 10 s, once", async () => {
  const { fake, add, pass } = await mailWorld();
  await fake.set({ hangs: ["*"] });

  // The call answers with no time passing: it does not wait for the mail.
  expect(await add("bo")).toEqual({ kind: "added" });
  await pass(1_000);
  expect(fake.tries()).toHaveLength(1);
  await fake.set({ hangs: [] });
  // The first send may still answer for 10 s: nobody sends the mail again before that.
  await pass(8_000);
  expect(fake.tries()).toHaveLength(1);
  await pass(60_000);
  expect(fake.sent().map((m) => m.to)).toEqual(["bo"]);
  expect(fake.tries()).toHaveLength(2);
});

test("slow mail: sends that take 3 s are not sent again; each person gets one mail", async () => {
  const { fake, add, pass } = await mailWorld();
  await fake.set({ slow: 3_000 });

  await add("bo");
  await add("cy");
  await add("dee");
  await pass(30_000);
  expect(
    fake
      .sent()
      .map((m) => m.to)
      .toSorted(),
  ).toEqual(["bo", "cy", "dee"]);
  expect(fake.tries()).toHaveLength(3);
});

// S17 (ck12): a mail is tried at most 4 times. After a failed try it waits 1 s, then 2 s, then
// 4 s. A mail whose 4th try fails is given up: it is never tried again, and `givenUp` keeps it.

test("a mail that fails is tried again after 1 s, 2 s and 4 s; its 4th fail gives it up, kept", async () => {
  const { fake, add, pass } = await mailWorld();
  await fake.set({ down: ["bo"] });

  expect(await add("bo")).toEqual({ kind: "added" });
  await pass(5_000);
  // Still trying: not given up yet.
  expect(fake.tries("bo").length).toBeGreaterThanOrEqual(2);
  expect(fake.tries("bo").length).toBeLessThan(4);
  expect(fake.givenUp()).toEqual([]);

  await pass(25_000);
  const tries = fake.tries("bo");
  expect(tries).toHaveLength(4);
  const waits = gaps(tries);
  for (const [i, wait] of [1_000, 2_000, 4_000].entries()) {
    expect(waits[i]).toBeGreaterThanOrEqual(wait);
    expect(waits[i]).toBeLessThanOrEqual(wait + 1_500);
  }
  expect(fake.givenUp().map((l) => [l.to, l.subject])).toEqual([["bo", "Welcome to MAIL"]]);

  // Given up: never tried again, and kept once.
  await pass(120_000);
  expect(fake.tries("bo")).toHaveLength(4);
  expect(fake.sent()).toEqual([]);
  expect(fake.givenUp()).toHaveLength(1);
}, 30_000);

test("a mail that fails twice arrives on its third try, once; nothing is given up", async () => {
  const { fake, add, pass } = await mailWorld();
  await fake.set({ fail: 2 });

  await add("bo");
  await pass(30_000);
  expect(fake.sent().map((m) => m.to)).toEqual(["bo"]);
  expect(fake.tries("bo")).toHaveLength(3);
  expect(fake.givenUp()).toEqual([]);
  await pass(60_000);
  expect(fake.tries("bo")).toHaveLength(3);
});

test("a try that never answers fails after 10 s and holds no other mail; 4 such tries give it up", async () => {
  const { fake, add, pass } = await mailWorld();
  await fake.set({ hangs: ["bo"], down: ["cy"] });

  await add("bo");
  await add("cy");
  await pass(500);
  await add("dee");
  // dee's mail is not held up by bo's hanging try, nor by cy's waits.
  await pass(2_000);
  expect(fake.sent().map((m) => m.to)).toEqual(["dee"]);
  await pass(6_000);
  expect(fake.tries("bo")).toHaveLength(1);

  await pass(120_000);
  const bo = fake.tries("bo");
  expect(bo).toHaveLength(4);
  const waits = gaps(bo);
  for (const [i, wait] of [1_000, 2_000, 4_000].entries()) {
    expect(waits[i]).toBeGreaterThanOrEqual(10_000 + wait);
    expect(waits[i]).toBeLessThanOrEqual(10_000 + wait + 2_500);
  }
  expect(fake.tries("cy")).toHaveLength(4);
  // Both given up, cy first (its tries fail at once), each kept once.
  expect(fake.givenUp().map((l) => l.to)).toEqual(["cy", "bo"]);
  expect(fake.sent().map((m) => m.to)).toEqual(["dee"]);
}, 30_000);

test("stopped while mail waits: the server closes with a try hanging and a mail waiting, at once", async () => {
  const { fake, add, pass, close } = await mailWorld();
  await fake.set({ hangs: ["bo"], down: ["cy"] });

  await add("bo");
  await add("cy");
  await pass(1_500);
  expect(fake.tries("bo")).toHaveLength(1);
  expect(fake.tries("cy").length).toBeGreaterThanOrEqual(1);
  // No time passes from here: a close that waits on the clock never ends.
  expect(await close()).toBe("closed");
}, 30_000);

test("the server cmd prints the welcome mail; the add answers first", async () => {
  type Server = typeof import("../cmds/server");
  const cmd: Server = await import(new URL("../cmds/server.ts", import.meta.url).href);

  const sink = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  const lines: string[] = [];
  const stop = new AbortController();
  const root = await cmd.default({
    env: {
      PORT: "0",
      OTEL_SERVICE_NAME: "mail-test",
      VICTORIA_TRACES_URL: `${sink.url}traces`,
      VICTORIA_LOGS_URL: `${sink.url}logs`,
    },
    args: [],
    cwd: process.cwd(),
    signal: stop.signal,
    stdout: {
      write: (x: string) => {
        lines.push(String(x));
        return true;
      },
    },
    stderr: { write: () => true },
    exit: (code, reason) => stop.abort(reason ?? code),
  });
  onTestFinished(async () => {
    stop.abort();
    await sink.stop(true);
  });
  if (!("resolve" in root)) throw new Error("the server cmd gave no scope");

  const at = root.resolve(serve.url).get();
  const ws = await createScope({
    capsules: [tab.client({ url: `${at}rpc`, meta: whoMeta }), issues.api({ remote: tab.client })],
  }).ready;
  ws.run(signIn, { input: { name: "ana" } });
  await ws.run(issues.api["team.create"], { input: { teamId: "CMD" } });
  expect(
    await ws.run(issues.api["team.add"], {
      input: { teamId: "CMD", userId: "bo", role: "member" },
    }),
  ).toEqual({ kind: "added" });

  const end = Date.now() + 8000;
  while (!lines.some((l) => l.includes("mail to bo: Welcome to CMD")) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lines.filter((l) => l.includes("Welcome to CMD"))).toEqual([
    "mail to bo: Welcome to CMD\n",
  ]);
  await ws.close();
}, 20_000);
