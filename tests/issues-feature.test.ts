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
  await until(() => state(cy, teamId) === "fault");
  expect(peek.get()).toEqual([]);
});

// A refused part is the server's answer: the tab does not ask again by itself (Core 0.17.4,
// ADR 0139). The page's "Try again" is an `invalidate` of the part, as a query's `refetch`.
test("a person added while their tab is open sees the team when they try again", async () => {
  const teamId = await team();
  const peek = read(cy, teamId);
  await ana.run(issues.api["issue.create"], { input: { teamId, title: "Welcome" } });
  await until(() => state(cy, teamId) === "fault");

  await ana.run(issues.api["team.add"], { input: { teamId, userId: "cy" } });
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
  expect(names(serverSpans, call)).toEqual([
    "issue.move.do",
    "issues.inTeam",
    "issues.signedIn",
    "remoteData.send",
    "rpc.answer",
    "ws.serve",
  ]);
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
  expect(names(serverSpans, ask)).toEqual([
    "issues.membersOnly",
    "issues.signedIn",
    "remoteData.answer",
    "remoteData.ask",
    "ws.serve",
  ]);
});
