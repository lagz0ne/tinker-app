import { createScope } from "@tinkered/core";
import type { Scope } from "@tinkered/core";
import { afterAll, expect, test } from "vite-plus/test";

import { issues } from "@/issues";
import { issueOps, membersOnly, signedIn } from "@/issues/ops.server";
import { signIn, whoMeta } from "@/issues/sign-in";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

// Adversarial probes (BackendForge style): error paths, team isolation, validation, state
// consistency, side effects. Each test is one probe. A red test is a finding, not a score.

const backend = await createScope({
  capsules: [
    issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
    issues.api({ implement: issueOps, onStart: [signedIn] }),
    server.server({ path: "/rpc", services: [issues.board, issues.api] }),
  ],
}).ready;
const { bun, url } = listen(backend, [server.server]);
const tabs: Scope.Handle[] = [];
const open = async (who: string) => {
  const scope = await createScope({
    capsules: [
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
const team = async () => {
  const teamId = `Q${++n}`;
  await ana.run(issues.api["team.create"], { input: { teamId } });
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "member" } });
  return teamId;
};
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const all = () => ({
  members: backend.resolve(issues.board.members).get(),
  issues: backend.resolve(issues.board.issues).get(),
  archived: backend.resolve(issues.board.archived).get(),
  labels: backend.resolve(issues.board.labels).get(),
  events: backend.resolve(issues.board.events).get(),
});
const of = (teamId: string) => {
  const a = all();
  return {
    members: a.members.filter((x) => x.teamId === teamId),
    issues: a.issues.filter((x) => x.teamId === teamId),
    archived: a.archived.filter((x) => x.teamId === teamId),
    labels: a.labels.filter((x) => x.teamId === teamId),
    events: a.events.filter((x) => x.teamId === teamId),
  };
};
const make = async (teamId: string, title = "t") => {
  await ana.run(issues.api["issue.create"], { input: { teamId, title } });
  return of(teamId).issues.find((i) => i.title === title)!;
};

afterAll(async () => {
  for (const s of tabs) await s.close();
  await bun.stop(true);
  await backend.close();
});

test("A01 parallel creates: numbers 1..N, no twin, no gap", async () => {
  const teamId = await team();
  const answers = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? bo : ana).run(issues.api["issue.create"], { input: { teamId, title: `p${i}` } }),
    ),
  );
  const nums = answers.map((a) => (a.kind === "created" ? a.number : -1)).toSorted((x, y) => x - y);
  expect(nums).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  expect(
    of(teamId)
      .issues.map((i) => i.number)
      .toSorted((x, y) => x - y),
  ).toEqual(nums);
});

test("A02 two moves from the same version at once: one moved, one stale, one event", async () => {
  const teamId = await team();
  const i = await make(teamId);
  const at = { teamId, id: i.id, version: 1 };
  const r = await Promise.all([
    ana.run(issues.api["issue.move"], { input: { ...at, state: "doing" } }),
    bo.run(issues.api["issue.rename"], { input: { ...at, title: "other" } }),
  ]);
  expect(r.filter((x) => x.kind === "stale")).toHaveLength(1);
  expect(of(teamId).events.filter((e) => e.id === i.id)).toHaveLength(2);
  expect(of(teamId).issues[0]?.version).toBe(2);
});

test("A03 a call that names another team's issue answers gone and writes nothing", async () => {
  const a = await team();
  const b = await team();
  const i = await make(b, "in b");
  const before = all();
  const at = { teamId: a, id: i.id, version: 1 };
  expect(await ana.run(issues.api["issue.move"], { input: { ...at, state: "done" } })).toEqual({
    kind: "gone",
  });
  expect(await ana.run(issues.api["issue.rename"], { input: { ...at, title: "x" } })).toEqual({
    kind: "gone",
  });
  expect(
    await ana.run(issues.api["issue.label"], { input: { ...at, name: "bug", on: true } }),
  ).toEqual({ kind: "gone" });
  expect(await ana.run(issues.api["issue.assign"], { input: { ...at, userId: "bo" } })).toEqual({
    kind: "gone",
  });
  expect(all()).toEqual(before);
});

/** The state of one part on a tab once it settles: rows, or a fault. */
const peek = async (scope: Scope.Handle, part: Parameters<Scope.Handle["resolve"]>[0]) => {
  // @ts-expect-error probe: any part of the board
  const r = scope.resolve(part);
  // @ts-expect-error probe
  r.watch(() => undefined);
  // @ts-expect-error probe
  const st = scope.resolve(issues.board.status(part));
  await until(() => ["ready", "fault"].includes(st.get()?.status ?? ""), 3000).catch(
    () => undefined,
  );
  // @ts-expect-error probe
  return { status: st.get()?.status, rows: st.get()?.status === "ready" ? r.get() : [] };
};

test("A04 a part with no team in its key leaks nothing to a person outside the team", async () => {
  const teamId = await team();
  const i = await make(teamId, "secret");
  await ana.run(issues.api["issue.assign"], {
    input: { teamId, id: i.id, version: 1, userId: "bo" },
  });
  await ana.run(issues.api["issue.label"], {
    input: { teamId, id: i.id, version: 2, name: "sec", on: true },
  });
  const leaks = [];
  for (const part of [
    issues.board.issues.where({ assignee: "bo" }),
    issues.board.labels.where({ name: "sec" }),
    issues.board.events.where({ by: "ana" }),
    issues.board.members.where({ role: "member" }),
    issues.board.issues.where({ id: i.id }),
  ]) {
    const got = await peek(cy, part);
    if ((got.rows as { teamId: string }[]).some((x) => x.teamId === teamId)) leaks.push(got);
  }
  if (leaks.length)
    throw new Error("LEAK " + leaks.map((l) => JSON.stringify(l.rows).slice(0, 200)).join(" ## "));
});

test("A05 a part by team and issue is refused to a person outside the team", async () => {
  const teamId = await team();
  const i = await make(teamId, "secret2");
  const leaks = [];
  for (const part of [
    issues.board.issues.of({ teamId, id: i.id }),
    issues.board.events.where({ teamId, id: i.id }),
    issues.board.labels.where({ teamId, id: i.id }),
    issues.board.members.of({ teamId, userId: "ana" }),
  ]) {
    const got = await peek(cy, part);
    if (got.status !== "fault") leaks.push(got);
  }
  expect(leaks).toEqual([]);
});

test("A06 a label put on twice is one change: no new version, no new event", async () => {
  const teamId = await team();
  const i = await make(teamId);
  const at = { teamId, id: i.id, name: "bug", on: true };
  expect(await ana.run(issues.api["issue.label"], { input: { ...at, version: 1 } })).toEqual({
    kind: "labeled",
    version: 2,
  });
  await bo.run(issues.api["issue.label"], { input: { ...at, version: 2 } });
  expect(of(teamId).issues[0]?.version).toBe(2);
  expect(of(teamId).events).toHaveLength(2);
});

test("A07 a label taken off that is not on changes nothing", async () => {
  const teamId = await team();
  const i = await make(teamId);
  await ana.run(issues.api["issue.label"], {
    input: { teamId, id: i.id, version: 1, name: "nope", on: false },
  });
  expect(of(teamId).issues[0]?.version).toBe(1);
  expect(of(teamId).events.map((e) => e.what)).toEqual(["created"]);
});

test("A08 a move to the state it is in changes nothing", async () => {
  const teamId = await team();
  const i = await make(teamId);
  await ana.run(issues.api["issue.move"], {
    input: { teamId, id: i.id, version: 1, state: "backlog" },
  });
  expect(of(teamId).issues[0]?.version).toBe(1);
  expect(of(teamId).events).toHaveLength(1);
});

test("A09 a member made a viewer is no longer an assignee", async () => {
  const teamId = await team();
  const i = await make(teamId);
  await ana.run(issues.api["issue.assign"], {
    input: { teamId, id: i.id, version: 1, userId: "bo" },
  });
  expect(
    await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "viewer" } }),
  ).toEqual({ kind: "added" });
  expect(of(teamId).issues[0]?.assignee).toBeUndefined();
});

test("A10 the last member cannot leave the team with no member", async () => {
  const teamId = `Q${++n}`;
  await ana.run(issues.api["team.create"], { input: { teamId } });
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "ana", role: "viewer" } });
  expect(of(teamId).members.filter((m) => m.role === "member").length).toBeGreaterThan(0);
});

test("A11 a delete of one team leaves a team whose key starts the same", async () => {
  const teamId = `Z${++n}`;
  const longer = `${teamId}0`;
  for (const t of [teamId, longer]) {
    await ana.run(issues.api["team.create"], { input: { teamId: t } });
    const i = await make(t);
    await ana.run(issues.api["issue.label"], {
      input: { teamId: t, id: i.id, version: 1, name: "x", on: true },
    });
  }
  const before = of(longer);
  expect(await ana.run(issues.api["team.delete"], { input: { teamId } })).toEqual({
    kind: "deleted",
  });
  expect(of(longer)).toEqual(before);
  expect(of(teamId)).toEqual({ members: [], issues: [], archived: [], labels: [], events: [] });
});

test("A12 a viewer naming an issue the team does not have: forbidden, not gone", async () => {
  const teamId = await team();
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "cy", role: "viewer" } });
  const at = { teamId, id: "no-such", version: 1 };
  expect(await cy.run(issues.api["issue.move"], { input: { ...at, state: "done" } })).toEqual({
    kind: "forbidden",
  });
  expect(await cy.run(issues.api["issue.assign"], { input: { ...at, userId: null } })).toEqual({
    kind: "forbidden",
  });
});

test("A13 an archived team with an old version: archived, not stale", async () => {
  const teamId = await team();
  const i = await make(teamId);
  await ana.run(issues.api["team.archive"], { input: { teamId } });
  const at = { teamId, id: i.id, version: 7 };
  expect(await bo.run(issues.api["issue.rename"], { input: { ...at, title: "x" } })).toEqual({
    kind: "archived",
  });
  expect(await bo.run(issues.api["issue.assign"], { input: { ...at, userId: "zed" } })).toEqual({
    kind: "archived",
  });
});

test("A14 a stale assignment to a non-member: stale, the assignee check comes last", async () => {
  const teamId = await team();
  const i = await make(teamId);
  expect(
    await ana.run(issues.api["issue.assign"], {
      input: { teamId, id: i.id, version: 5, userId: "zed" },
    }),
  ).toEqual({ kind: "stale", version: 1 });
});

test("A15 a version that is not a whole number is stale and writes nothing", async () => {
  const teamId = await team();
  const i = await make(teamId);
  const before = all();
  expect(
    await ana.run(issues.api["issue.move"], {
      input: { teamId, id: i.id, version: 1.5, state: "done" },
    }),
  ).toEqual({ kind: "stale", version: 1 });
  expect(all()).toEqual(before);
});

test("A16 a team made again after a delete by someone else: old members' calls answer gone", async () => {
  const teamId = await team();
  await make(teamId);
  await ana.run(issues.api["team.delete"], { input: { teamId } });
  expect(await cy.run(issues.api["team.create"], { input: { teamId } })).toEqual({
    kind: "created",
    teamId,
  });
  expect(await bo.run(issues.api["issue.create"], { input: { teamId, title: "x" } })).toEqual({
    kind: "gone",
  });
  expect(await ana.run(issues.api["team.delete"], { input: { teamId } })).toEqual({ kind: "gone" });
  expect(of(teamId).members.map((m) => m.userId)).toEqual(["cy"]);
});

test("A17 an assignment that is notAssignable writes nothing", async () => {
  const teamId = await team();
  const i = await make(teamId);
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "cy", role: "viewer" } });
  const before = all();
  expect(
    await ana.run(issues.api["issue.assign"], {
      input: { teamId, id: i.id, version: 1, userId: "cy" },
    }),
  ).toEqual({ kind: "notAssignable" });
  expect(
    await ana.run(issues.api["issue.assign"], {
      input: { teamId, id: i.id, version: 1, userId: "" },
    }),
  ).toEqual({ kind: "notAssignable" });
  expect(all()).toEqual(before);
});

test("A18 each event keeps who did it; a later change does not rewrite an earlier event", async () => {
  const teamId = await team();
  const i = await make(teamId);
  await bo.run(issues.api["issue.move"], {
    input: { teamId, id: i.id, version: 1, state: "todo" },
  });
  await ana.run(issues.api["issue.rename"], {
    input: { teamId, id: i.id, version: 2, title: "r" },
  });
  expect(
    of(teamId)
      .events.toSorted((x, y) => x.version - y.version)
      .map((e) => [e.version, e.by, e.what]),
  ).toEqual([
    [1, "ana", "created"],
    [2, "bo", "moved"],
    [3, "ana", "renamed"],
  ]);
});

test("A19 a delete on a team with many parts takes every one", async () => {
  const teamId = await team();
  for (let k = 0; k < 6; k++) {
    const i = await make(teamId, `m${k}`);
    await ana.run(issues.api["issue.label"], {
      input: { teamId, id: i.id, version: 1, name: `l${k}`, on: true },
    });
    await ana.run(issues.api["issue.assign"], {
      input: { teamId, id: i.id, version: 2, userId: "bo" },
    });
  }
  await ana.run(issues.api["team.archive"], { input: { teamId } });
  expect(await bo.run(issues.api["team.delete"], { input: { teamId } })).toEqual({
    kind: "deleted",
  });
  expect(of(teamId)).toEqual({ members: [], issues: [], archived: [], labels: [], events: [] });
});

test("A20 a member's own team list drops a team that made them a viewer? no: keeps it with the role", async () => {
  const teamId = await team();
  const mine = await peek(bo, issues.board.members.where({ userId: "bo" }));
  expect(mine.status).toBe("ready");
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "viewer" } });
  const r = bo.resolve(issues.board.members.where({ userId: "bo" }));
  await until(() => r.get().some((m) => m.teamId === teamId && m.role === "viewer"));
});
