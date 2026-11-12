import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { createScope, operation } from "@tinkered/core";
import type { Observe, Scope } from "@tinkered/core";
import { createMemory, memory } from "@tinkered/core/testing";
import { ScopeProvider } from "@tinkered/react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
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
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const tab = async (name: string) => {
    const scope = await createScope({
      capsules: [
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
  root.render(
    <ScopeProvider scope={bo}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await page.getByLabelText("New issue").fill("Login fails");
  await page.getByRole("button", { name: "Add issue" }).click();
  await expect.element(page.getByRole("link", { name: "ENG-1" })).toBeVisible();

  const [made] = ana.resolve(issues.board.issues.where({ teamId: "ENG" })).get();
  const id = made?.id ?? server.resolve(issues.board.issues).get()[0]!.id;
  await ana.run(issues.api["issue.move"], {
    input: { teamId: "ENG", id, version: 1, state: "done" },
  });
  const done = page.getByRole("region", { name: "done" });
  await expect.element(done.getByRole("link", { name: "ENG-1" })).toBeVisible();

  await page.getByLabelText("State of ENG-1").selectOptions("todo");
  await expect.poll(() => server.resolve(issues.board.issues).get()[0]?.state).toBe("todo");

  await page.getByRole("link", { name: "ENG-1" }).click();
  await page.getByLabelText("Comment").fill("Seen on Safari");
  await page.getByRole("button", { name: "Comment" }).click();
  await expect.element(page.getByText("bo: Seen on Safari")).toBeVisible();

  root.unmount();
  await ana.close();
  await bo.close();
  await server.close();
});

test('a tab that is not in the team sees why; "Try again" shows the team once it is in', async () => {
  const server = await createScope({
    capsules: [
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const cy = await createScope({
    capsules: [
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  cy.run(signIn, { input: { name: "cy" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/OPS"] });
  const router = createRouter({ routeTree, history, context: { scope: cy } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  root.render(
    <ScopeProvider scope={cy}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await expect.element(page.getByRole("alert")).toHaveTextContent("You are not in team OPS.");

  await cy.run(issues.api["team.create"], { input: { teamId: "OPS" } });
  await page.getByRole("button", { name: "Try again" }).click();

  await expect.element(page.getByRole("heading", { name: "OPS" })).toBeVisible();

  root.unmount();
  await cy.close();
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
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: { ...issueOps, "issue.create": boom }, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  // The tab observes, as the real page does (`telemetry.browser`): the fault's ref is its trace.
  const ana = await createScope({
    observe: { export: () => undefined },
    capsules: [
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

  root.unmount();
  await ana.close();
  await server.close();
});

// `link` on a read: the server goes away with the page open. Its close ends the open watch
// (Core 0.17.6), so the part is a fault, and the page says so in place of the form. Core asks
// again by itself.
test("the server goes away with the page open: the page says that it is offline", async () => {
  const server = await createScope({
    capsules: [
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: issueOps, onStart: [signedIn] }),
      memory.server({ services: [issues.board, issues.api] }),
    ],
  }).ready;
  const ana = await createScope({
    capsules: [
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

  root.unmount();
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
        memory.client({ peer: input.reads }),
        issues.board({ read: memory.client }),
        calls.client({ peer: input.api }),
        issues.api({ remote: calls.client }),
      ],
    }).ready;
    const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
    const router = createRouter({ routeTree, history, context: { scope: ana } });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    root.render(
      <ScopeProvider scope={ana}>
        <RouterProvider router={router} />
      </ScopeProvider>,
    );

    return { ana, root };
  },
});

test("a call that did not leave says that nothing was sent", async () => {
  const reads = await createScope({
    capsules: [issues.board({ serve: true }), memory.server({ services: [issues.board] })],
  }).ready;
  const api = await createScope({
    capsules: [issues.api({ implement: issueOps }), calls.server({ services: [issues.api] })],
  }).ready;
  const { ana, root } = await reads.run(pageOf, { input: { reads, api } });
  await page.getByLabelText("New issue").fill("Login fails");

  await api.close(); // the server of the calls is away: a call cannot leave
  await page.getByRole("button", { name: "Add issue" }).click();

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("Offline. Nothing was sent. Try again.");

  root.unmount();
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
    capsules: [issues.board({ serve: true }), memory.server({ services: [issues.board] })],
  }).ready;
  const api = await createScope({
    capsules: [
      issues.api({ implement: { ...issueOps, "issue.create": create } }),
      calls.server({ services: [issues.api] }),
    ],
  }).ready;
  const { ana, root } = await reads.run(pageOf, { input: { reads, api } });
  await page.getByLabelText("New issue").fill("Login fails");
  await page.getByRole("button", { name: "Add issue" }).click();
  await work.promise;

  const gone = api.close();
  done.resolve();
  await gone;

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("No answer. It may be saved. Look, then try again.");

  root.unmount();
  await ana.close();
  await reads.close();
});

// `missing` is the server's answer: it does not have the address. On a page that means an old
// page against a new server, so the page says to load it again. Nothing asks again.
test("a call to an address the server does not have says that the page is old", async () => {
  // A server that serves the board, and no `issues.api`: every call to it is `missing`.
  const server = await createScope({
    capsules: [issues.board({ serve: true }), memory.server({ services: [issues.board] })],
  }).ready;
  const ana = await createScope({
    capsules: [
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: ana } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
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

  root.unmount();
  await ana.close();
  await server.close();
});
