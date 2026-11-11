import { createScope } from "@tinker/core";
import type { Scope } from "@tinker/core";
import { memory } from "@tinker/core/testing";
import { afterEach, expect, test } from "vite-plus/test";

import { issues } from "@/issues";
import { issueOps, memberOnly, signedIn } from "@/issues/index.server";

// The issue board as the two cmds would install it: the server serves the board to members and
// implements the api; each tab reads the board and calls the api. Over `memory`, the socket's
// protocol. `x-who` stands in for a sign-in cookie.

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function boot() {
  const server = await createScope({
    capsules: [
      issues.board({ serve: true, onStart: [signedIn, memberOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  closers.push(() => server.close());

  const tab = async (who: string) => {
    const scope = await createScope({
      capsules: [
        memory.client({ peer: server, headers: { "x-who": who } }),
        issues.board({ read: memory.client }),
        issues.api({ remote: memory.client }),
      ],
    }).ready;
    closers.push(() => scope.close());
    return scope;
  };

  return { server, tab };
}

/** A tab's reader of one team's issues, kept in use: a keyed board serves only parts in use. */
const teamIssues = (scope: Scope.Handle, teamId: string) => {
  const reader = scope.resolve(issues.board.issues.where({ teamId }));
  reader.watch(() => undefined);
  return reader;
};

const until = async (ok: () => boolean) => {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function engTeam() {
  const { server, tab } = await boot();
  const [a, b] = [await tab("ana"), await tab("bo")];
  const { id: teamId } = await a.run(issues.api["team.create"], {
    input: { key: "eng", name: "Engineering" },
  });
  await a.run(issues.api["team.addMember"], { input: { teamId, userId: "bo" } });
  return { server, tab, a, b, teamId };
}

test("issue numbers count per team with no gap: ENG-1, ENG-2", async () => {
  const { a, teamId } = await engTeam();
  const one = await a.run(issues.api["issue.create"], {
    input: { teamId, title: "Sign in", state: "todo" },
  });
  const two = await a.run(issues.api["issue.create"], {
    input: { teamId, title: "Board", state: "todo" },
  });
  expect([one.number, two.number]).toEqual([1, 2]);
});

test("a move on one tab lands on the other tab's team part", async () => {
  const { a, b, teamId } = await engTeam();
  const seen = teamIssues(b, teamId);
  const { id } = await a.run(issues.api["issue.create"], {
    input: { teamId, title: "Drag me", state: "todo" },
  });
  await until(() => seen.get().length === 1);

  expect(
    await a.run(issues.api["issue.move"], {
      input: { teamId, id, version: 1, state: "done", beforeId: null },
    }),
  ).toEqual({
    kind: "moved",
    version: 2,
  });
  await until(() => seen.get()[0]?.state === "done");
});

test("a stale edit is an outcome, not an error: the second move with version 1 is refused", async () => {
  const { a, b, teamId } = await engTeam();
  const { id } = await a.run(issues.api["issue.create"], {
    input: { teamId, title: "Race", state: "todo" },
  });
  const move = { teamId, id, version: 1, beforeId: null };
  await a.run(issues.api["issue.move"], { input: { ...move, state: "in_progress" } });
  expect(await b.run(issues.api["issue.move"], { input: { ...move, state: "done" } })).toEqual({
    kind: "stale",
    version: 2,
  });
});

test("cards sort by rank inside a lane; a drop before a card lands before it", async () => {
  const { a, teamId } = await engTeam();
  const seen = teamIssues(a, teamId);
  const make = (title: string) =>
    a.run(issues.api["issue.create"], { input: { teamId, title, state: "todo" } });
  const [x, y, z] = [await make("x"), await make("y"), await make("z")];
  await a.run(issues.api["issue.move"], {
    input: { teamId, id: z.id, version: 1, state: "todo", beforeId: x.id },
  });
  await until(() => seen.get().find((i) => i.id === z.id)?.version === 2);

  const order = seen
    .get()
    .toSorted((p, q) => p.rank - q.rank)
    .map((i) => i.title);
  expect(order).toEqual(["z", "x", "y"]);
  expect(y.number).toBe(2);
});

test("comments: a second keyed cell, read by team and issue", async () => {
  const { a, b, teamId } = await engTeam();
  const { id: issueId } = await a.run(issues.api["issue.create"], {
    input: { teamId, title: "Talk", state: "todo" },
  });
  const thread = b.resolve(issues.board.comments.where({ teamId, issueId }));
  thread.watch(() => undefined);

  await a.run(issues.api["comment.add"], { input: { teamId, issueId, text: "Looks good" } });
  await until(() => thread.get().length === 1);

  expect(thread.get()[0]).toMatchObject({ author: "ana", text: "Looks good" });
});

test("a non-member's read of the team is refused; the members' part still flows", async () => {
  const { a, tab, teamId } = await engTeam();
  const cy = await tab("cy");
  const peek = teamIssues(cy, teamId);
  const mine = teamIssues(a, teamId);
  await a.run(issues.api["issue.create"], { input: { teamId, title: "Secret", state: "todo" } });
  await until(() => mine.get().length === 1);
  await until(() => cy.resolve(issues.board.faults).get().issues !== undefined);

  expect(peek.get()).toEqual([]);
  expect(cy.resolve(issues.board.faults).get().issues?.message).toContain("refused");
});

// The tab asks a refused part again with back-off (50 ms, doubling, at most 5 s), as
// EventSource retries: the grant shows with no signal from the server.
test("a member added while the tab is open starts to see the team, by the retry", async () => {
  const { a, tab, teamId } = await engTeam();
  const cy = await tab("cy");
  const peek = teamIssues(cy, teamId);
  await a.run(issues.api["issue.create"], { input: { teamId, title: "Welcome", state: "todo" } });
  await until(() => cy.resolve(issues.board.faults).get().issues !== undefined);

  await a.run(issues.api["team.addMember"], { input: { teamId, userId: "cy" } });
  await until(() => peek.get().length === 1);
});
