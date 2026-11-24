import { exits } from "@tinkered/cli/test";
import { createScope } from "@tinkered/core";
import type { Observe, Scope } from "@tinkered/core";
import { afterAll, beforeEach, expect, test } from "vite-plus/test";

import { issues } from "@/issues";
import { issueOps, membersOnly, signedIn } from "@/issues/ops.server";
import { signIn, whoMeta } from "@/issues/sign-in";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

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
  ] as const;
  for (const part of parts) scope.resolve(part).watch(() => undefined);

  return () =>
    parts.map((part) => {
      const now = scope.resolve(issues.board.status(part)).get();
      return now?.status === "fault" ? now.fault : undefined;
    });
};

// S5, each part of a team: members, issues, the archive mark and the labels. A read from outside the team is refused
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
  expect(outside()).toMatchObject([refused, refused, refused, refused]);
  expect(nobody().map((fault) => fault?.fault)).toEqual([
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
  const send = one(serverSpans, "remoteData.send");
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
