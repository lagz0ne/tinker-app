import { createScope } from "@tinker/core";
import type { Observe, Scope } from "@tinker/core";
import { afterAll, beforeEach, expect, test } from "vite-plus/test";

import { issues, signIn, whoMeta } from "@/issues";
import { issueOps, membersOnly, signedIn } from "@/issues/index.server";

import { listen, wsClient as tab, wsServer as server } from "./support/ws";

// The issue board as the cmds install it, over a real socket: the server serves each team's parts
// to its members and implements the api; each tab reads the board and calls the api. The `who`
// name in each message's meta stands in for sign-in. Both sides export their spans, so a test can follow one trace.

const serverSpans: Observe.Span[] = [];
const tabSpans: Observe.Span[] = [];

const backend = await createScope({
  observe: { export: (span) => void serverSpans.push(span) },
  capsules: [
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
  await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo" } });
  return teamId;
};

/** A tab's reader of one team's issues, kept in use: a keyed board serves only parts in use. */
const read = (scope: Scope.Handle, teamId: string) => {
  const reader = scope.resolve(issues.board.issues.where({ teamId }));
  reader.watch(() => undefined);
  return reader;
};

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

  expect(again).toEqual({ kind: "exists" });
  expect([await add("one"), await add("two")]).toEqual([
    { kind: "created", number: 1 },
    { kind: "created", number: 2 },
  ]);
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
});

test("comments: a part of their own, read by team and issue", async () => {
  const teamId = await team();
  const seen = read(ana, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Talk" } });
  await until(() => seen.get().length === 1);
  const issueId = seen.get()[0]!.id;
  const thread = bo.resolve(issues.board.comments.where({ teamId, issueId }));
  thread.watch(() => undefined);

  await ana.run(issues.api["comment.add"], { input: { teamId, issueId, text: "Looks good" } });
  await until(() => thread.get().length === 1);

  expect(thread.get()[0]).toMatchObject({ author: "ana", text: "Looks good" });
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
  await until(() => cy.resolve(issues.board.faults).get().issues !== undefined);
  expect(peek.get()).toEqual([]);
});

// The tab asks a refused part again with back-off (50 ms, doubling, at most 5 s), as
// EventSource retries: the grant shows with no signal from the server.
test("a person added while their tab is open starts to see the team, by the retry", async () => {
  const teamId = await team();
  const peek = read(cy, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Welcome" } });
  await until(() => cy.resolve(issues.board.faults).get().issues !== undefined);

  await ana.run(issues.api["team.add"], { input: { teamId, userId: "cy" } });
  await until(() => peek.get().length === 1);
});

/** The one span of this name; its trace id. */
const one = (spans: Observe.Span[], name: string) => {
  const found = spans.filter((span) => span.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
};

// One move, followed across both tabs and the server. The call is one trace: tab A's call, its
// socket send, the server's serve, the guard, the op. The signal to tab B and B's ask again are
// a second trace: the keyed signal carries no traceparent yet (Core gap, sent to Core). When it
// does, the second trace links to the first, and this test checks the link.
test("one move: the call is one trace across tab and server; the other tab's ask is one more", async () => {
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
  const ask = one(tabSpans, "issues.ask").traceId;

  expect(names(tabSpans, call)).toEqual(["issue.move", "issues.whoMeta", "ws.call", "ws.send"]);
  expect(names(serverSpans, call)).toEqual([
    "issue.move.do",
    "issues.inTeam",
    "issues.signedIn",
    "rpc.answer",
    "ws.serve",
  ]);
  expect(names(tabSpans, ask)).toEqual(["issues.ask", "issues.whoMeta", "ws.call", "ws.send"]);
  expect(names(serverSpans, ask)).toEqual([
    "issues.membersOnly",
    "issues.signedIn",
    "remoteData.answer",
    "remoteData.ask",
    "ws.serve",
  ]);
  expect(ask).not.toBe(call);
});
