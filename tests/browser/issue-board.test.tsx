import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { createScope, operation } from "@tinker/core";
import type { Observe } from "@tinker/core";
import { memory } from "@tinker/core/testing";
import { ScopeProvider } from "@tinker/react";
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

// `link` is the one fault with no answer from the server: the call may have run. A call is not
// sent again by itself, so the page says so and the person looks first.
test("a call with no answer says that it may be saved; it is not sent again", async () => {
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
  await page.getByLabelText("New issue").fill("Login fails");

  // The server goes away with the page open: the next call gets no answer. Its close settles
  // only after the client leaves (it holds an open watch), so the test does not wait for it here.
  const gone = server.close();
  await page.getByRole("button", { name: "Add issue" }).click();

  await expect
    .poll(() => document.querySelector("main [role=status]")?.textContent)
    .toBe("No answer. It may be saved. Look, then try again.");

  root.unmount();
  await ana.close();
  await gone;
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
