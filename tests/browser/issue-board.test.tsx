import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { exits } from "@tinkered/cli/test";
import { createScope, operation, transport } from "@tinkered/core";
import type { Observe, Scope } from "@tinkered/core";
import { createMemory, memory } from "@tinkered/core/testing";
import { ScopeProvider } from "@tinkered/react";
import { createRoot } from "react-dom/client";
import { expect, onTestFinished, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";
import { z } from "zod";

import { issues, signIn, whoMeta } from "@/issues";
import { issueOps, membersOnly, signedIn } from "@/issues/index.server";
import { routeTree } from "@/routes";

// In a real Chromium: the board's pages over `memory`, with the app's own routes. Two tabs are
// two scopes; tab B is drawn, tab A only calls.

test("an issue made and moved on one tab moves on the drawn tab; a thread takes a comment", async () => {
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const tab = async (name: string) => {
    const scope = await createScope({
      capsules: [
        exits({ store: localStorage }),
        memory.client({ peer: server, meta: whoMeta }),
        issues.board({ read: memory.client }),
        issues.api({ remote: memory.client }),
      ],
    }).ready;
    scope.run(signIn, { input: { name } });
    return scope;
  };
  const [ana, bo] = [await tab("ana"), await tab("bo")];
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  await ana.run(issues.api["team.add"], { input: { teamId: "ENG", userId: "bo" } });

  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: bo } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={bo}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await page.getByLabelText("New issue").fill("Login fails");
  await page.getByRole("button", { name: "Add issue" }).click();
  await expect.element(page.getByRole("link", { name: "ENG-1" })).toBeVisible();
  // P2: four lanes. A new card is in backlog, with its title.
  for (const lane of ["backlog", "todo", "doing", "done"]) {
    // In the page, not "visible": a lane with no card and no heading has no size.
    await expect.element(page.getByRole("region", { name: lane, exact: true })).toBeInTheDocument();
  }
  const backlog = page.getByRole("region", { name: "backlog", exact: true });
  await expect.element(backlog.getByRole("link", { name: "ENG-1" })).toBeVisible();
  expect(backlog.element().textContent).toContain("Login fails");
  // P2: a lane lists its cards by number.
  await page.getByLabelText("New issue").fill("Logout fails");
  await page.getByRole("button", { name: "Add issue" }).click();
  await expect
    .poll(() => [...backlog.element().querySelectorAll("a")].map((a) => a.textContent))
    .toEqual(["ENG-1", "ENG-2"]);

  const [made] = ana.resolve(issues.board.issues.where({ teamId: "ENG" })).get();
  const id = made?.id ?? server.resolve(issues.board.issues).get()[0]!.id;
  await ana.run(issues.api["issue.move"], {
    input: { teamId: "ENG", id, version: 1, state: "done" },
  });
  const done = page.getByRole("region", { name: "done" });
  await expect.element(done.getByRole("link", { name: "ENG-1" })).toBeVisible();
  await expect.element(backlog.getByRole("link", { name: "ENG-1" })).not.toBeInTheDocument();

  // P2: the member form adds a person to the team.
  await page.getByRole("textbox", { name: "Add member" }).fill("cy");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect
    .poll(() =>
      server
        .resolve(issues.board.members)
        .get()
        .map((m) => m.userId),
    )
    .toContain("cy");

  await page.getByLabelText("State of ENG-1").selectOptions("todo");
  await expect.poll(() => server.resolve(issues.board.issues).get()[0]?.state).toBe("todo");

  await page.getByRole("link", { name: "ENG-1" }).click();
  await page.getByLabelText("Comment").fill("Seen on Safari");
  await page.getByRole("button", { name: "Comment" }).click();
  await expect.element(page.getByText("bo: Seen on Safari")).toBeVisible();

  await ana.close();
  await bo.close();
  await server.close();
});

// P1: the home page signs the person in and opens a team. Nobody made the team before, so the
// page makes it: the board that follows is read as a member.
test('"Open team" on a new key makes the team and shows its board', async () => {
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const dee = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  const history = createMemoryHistory({ initialEntries: ["/issues"] });
  const router = createRouter({ routeTree, history, context: { scope: dee } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={dee}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await page.getByLabelText("Your name").fill("dee");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The contract upper-cases a key, so the page opens the team under that key.
  await page.getByLabelText("Team key").fill("new");
  await page.getByRole("button", { name: "Open team" }).click();

  await expect.element(page.getByRole("heading", { name: "NEW" })).toBeVisible();
  await expect.element(page.getByLabelText("New issue")).toBeVisible();
  expect(history.location.pathname).toBe("/issues/NEW");

  await dee.close();
  await server.close();
});

test('a tab that is not in the team sees why; "Try again" shows the team once it is in', async () => {
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const cy = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  cy.run(signIn, { input: { name: "cy" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/OPS"] });
  const router = createRouter({ routeTree, history, context: { scope: cy } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={cy}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await expect.element(page.getByRole("alert")).toHaveTextContent("You are not in team OPS.");

  await cy.run(issues.api["team.create"], { input: { teamId: "OPS" } });
  await page.getByRole("button", { name: "Try again" }).click();

  await expect.element(page.getByRole("heading", { name: "OPS" })).toBeVisible();

  await cy.close();
  await server.close();
});

// The thread's part is read on its own, so it waits on its own: a refused thread says so in the
// thread, with "Try again", in place of an empty list that reads as "no comments".
test('a refused thread says why; "Try again" shows its comments once it is allowed', async () => {
  let shut = true;
  const threads = operation({
    label: "test.issues.threads",
    input: transport.hook.start,
    run: (_, { input }) => {
      const part = issues.board.part(input);
      return shut && part && "issueId" in part ? input.refuse({ notMember: "ENG" }) : undefined;
    },
  });
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly, threads] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  await ana.run(issues.api["issue.create"], { input: { teamId: "ENG", title: "Login fails" } });
  const id = server.resolve(issues.board.issues).get()[0]!.id;
  await ana.run(issues.api["comment.add"], { input: { teamId: "ENG", issueId: id, text: "Seen" } });
  const history = createMemoryHistory({ initialEntries: [`/issues/ENG/${id}`] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={ana}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );
  const thread = page.getByRole("complementary", { name: "Comments" });

  await expect.element(thread.getByRole("alert")).toHaveTextContent("You are not in team ENG.");

  shut = false;
  await thread.getByRole("button", { name: "Try again" }).click();

  await expect.element(thread.getByText("ana: Seen")).toBeVisible();

  await ana.close();
  await server.close();
});

// P4: a read with no `who` is refused by `signedIn`: the page says to sign in.
test("a tab that is not signed in is told to sign in", async () => {
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const nobody = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: nobody } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={nobody}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await expect
    .poll(() => document.querySelector("main [role=alert]")?.textContent)
    .toBe("Sign in first.");
  expect(document.querySelector("form")).toBeNull();

  await nobody.close();
  await server.close();
});

// P4: until the server answers the read, the page says that it loads, and shows no board. The
// server's start hook holds the read here, so the wait is as long as the test needs.
test("a board that is not read yet says that it loads", async () => {
  const answer = Promise.withResolvers<void>();
  const hold = operation({
    label: "test.issues.hold",
    input: transport.hook.start,
    run: async () => {
      await answer.promise;

      return undefined;
    },
  });
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly, hold] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={ana}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("Loading.");
  expect(document.querySelector("form")).toBeNull();

  answer.resolve();
  await expect.element(page.getByRole("heading", { name: "ENG" })).toBeVisible();

  await ana.close();
  await server.close();
});

// P2: the server answers `stale` when the card's version is not its own. The answer is replaced
// here, so the page's move is stale with no race between two tabs.
test("a stale move says that someone else changed the issue", async () => {
  const stale = operation({
    label: "test.issue.move.stale",
    input: issues.api["issue.move"].input,
    run: () => ({ kind: "stale" as const, version: 7 }),
  });
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: { ...issueOps, "issue.move": stale }, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  await ana.run(issues.api["issue.create"], { input: { teamId: "ENG", title: "Login fails" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={ana}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await page.getByLabelText("State of ENG-1").selectOptions("doing");

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("Changed by someone else.");
  const backlog = page.getByRole("region", { name: "backlog", exact: true });
  await expect.element(backlog.getByRole("link", { name: "ENG-1" })).toBeVisible();

  await ana.close();
  await server.close();
});

// P4: `gone` is an answer, so the page says it as a status. The answers are replaced here: a
// member's own page gets `gone` only in a race (the issue or the membership went away).
test("a call that answers gone says so", async () => {
  const moveGone = operation({
    label: "test.issue.move.gone",
    input: issues.api["issue.move"].input,
    run: () => ({ kind: "gone" as const }),
  });
  const addGone = operation({
    label: "test.team.add.gone",
    input: issues.api["team.add"].input,
    run: () => ({ kind: "gone" as const }),
  });
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({
        implement: { ...issueOps, "issue.move": moveGone, "team.add": addGone },
        onStart: [signedIn],
      }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  await ana.run(issues.api["issue.create"], { input: { teamId: "ENG", title: "Login fails" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={ana}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );
  const said = () => [...document.querySelectorAll("main [role=status]")].map((e) => e.textContent);

  await page.getByLabelText("State of ENG-1").selectOptions("doing");
  await expect.poll(said).toEqual(["This issue is gone."]);

  await page.getByRole("textbox", { name: "Add member" }).fill("cy");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect.poll(said).toContain("That is gone, or you are not in this team.");

  await ana.close();
  await server.close();
});

test("a call that breaks on the server shows a ref, and the server's trace has the cause", async () => {
  const spans: Observe.Span[] = [];
  const boom = operation({
    label: "issue.create.boom",
    input: z.object({ teamId: z.string(), title: z.string() }),
    run: (): { kind: "gone" } => {
      throw new Error("the disk is full");
    },
  });
  const server = await createScope({
    observe: { export: (span) => void spans.push(span) },
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: { ...issueOps, "issue.create": boom }, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  // The tab observes, as the real page does (`telemetry.browser`): the fault's ref is its trace.
  const ana = await createScope({
    observe: { export: () => undefined },
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={ana}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await page.getByLabelText("New issue").fill("Login fails");
  await page.getByRole("button", { name: "Add issue" }).click();
  await expect
    .poll(() => document.querySelector("[role=alert]")?.textContent)
    .toMatch(/^Something broke\. Ref [0-9a-f]{8}$/);

  const ref = page.getByRole("alert").element().textContent!.slice(-8);
  const failed = spans.find((span) => span.name === "issue.create.boom");
  expect(failed?.traceId.slice(0, 8)).toBe(ref);
  expect(String(failed?.error)).toContain("the disk is full");

  await ana.close();
  await server.close();
});

// `link` on a read: the server goes away with the page open. Its close ends the open watch
// (Core 0.17.6), so the part is a fault, and the page says so in place of the form. Core asks
// again by itself.
test("the server goes away with the page open: the page says that it is offline", async () => {
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={ana}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );
  await expect.element(page.getByLabelText("New issue")).toBeVisible();

  await server.close();

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("Offline. Trying again.");
  expect(document.querySelector("form")).toBeNull();
  // A broken link heals by itself: there is nothing for the person to press.
  expect([...document.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
    "Try again",
  );

  await ana.close();
});

// `link` on a call: the reads and the calls go over two links here (as sse and http), so the
// board stays ready when only the calls get no answer. A call is never sent again by itself.
const calls = createMemory();

/** The page of `ana` on team ENG: the board from `reads`, the calls to `api` over `calls`. */
const pageOf = operation({
  label: "test.issues.page",
  input: z.custom<{ reads: Scope.Handle; api: Scope.Handle }>(),
  run: async (_, { input }) => {
    const ana = await createScope({
      capsules: [
        exits({ store: localStorage }),
        memory.client({ peer: input.reads }),
        issues.board({ read: memory.client }),
        calls.client({ peer: input.api }),
        issues.api({ remote: calls.client }),
      ],
    }).ready;
    const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
    const router = createRouter({ routeTree, history, context: { scope: ana } });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    // A test that fails leaves no page behind for the next one.
    onTestFinished(() => root.unmount());
    root.render(
      <ScopeProvider scope={ana}>
        <RouterProvider router={router} />
      </ScopeProvider>,
    );

    return { ana };
  },
});

test("a call that did not leave says that nothing was sent", async () => {
  const reads = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true }),
      memory.server({ services: [issues.board] }),
    ],
  }).ready;
  const api = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.api({ implement: issueOps }),
      calls.server({ services: [issues.api] }),
    ],
  }).ready;
  const { ana } = await reads.run(pageOf, { input: { reads, api } });
  await page.getByLabelText("New issue").fill("Login fails");

  await api.close(); // the server of the calls is away: a call cannot leave
  await page.getByRole("button", { name: "Add issue" }).click();

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("Offline. Nothing was sent. Try again.");

  await ana.close();
  await reads.close();
});

test("a call that left and got no answer says that it may be saved", async () => {
  // The server does the work, then goes away before its answer leaves.
  const work = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  const create = operation({
    label: "test.issue.create.slow",
    input: z.object({ teamId: z.string(), title: z.string() }),
    run: async () => {
      work.resolve();
      await done.promise;

      return { kind: "created" as const, number: 1 };
    },
  });
  const reads = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true }),
      memory.server({ services: [issues.board] }),
    ],
  }).ready;
  const api = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.api({ implement: { ...issueOps, "issue.create": create } }),
      calls.server({ services: [issues.api] }),
    ],
  }).ready;
  const { ana } = await reads.run(pageOf, { input: { reads, api } });
  await page.getByLabelText("New issue").fill("Login fails");
  await page.getByRole("button", { name: "Add issue" }).click();
  await work.promise;

  const gone = api.close();
  done.resolve();
  await gone;

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("No answer. It may be saved. Look, then try again.");

  await ana.close();
  await reads.close();
});

// `missing` is the server's answer: it does not have the address. On a page that means an old
// page against a new server, so the page says to load it again. Nothing asks again.
test("a call to an address the server does not have says that the page is old", async () => {
  // A server that serves the board, and no `issues.api`: every call to it is `missing`.
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true }),
      memory.server({ services: [issues.board] }),
    ],
  }).ready;
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  // A test that fails leaves no page behind for the next one.
  onTestFinished(() => root.unmount());
  root.render(
    <ScopeProvider scope={ana}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await page.getByLabelText("New issue").fill("Login fails");
  await page.getByRole("button", { name: "Add issue" }).click();

  await expect
    .poll(() => document.querySelector("main [role=alert]")?.textContent)
    .toBe("This page is old. Load it again.");

  await ana.close();
  await server.close();
});
