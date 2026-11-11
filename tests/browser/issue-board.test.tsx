import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { createScope } from "@tinker/core";
import { memory } from "@tinker/core/testing";
import { ScopeProvider } from "@tinker/react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser/context";

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

test("a tab that is not in the team sees why, not an empty board", async () => {
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

  root.unmount();
  await cy.close();
  await server.close();
});
