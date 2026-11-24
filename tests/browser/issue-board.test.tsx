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

import { issues } from "@/issues";
import { members } from "@/issues/contract";
import { issueOps, membersOnly, signedIn } from "@/issues/ops.server";
import { signIn, whoMeta } from "@/issues/sign-in";
import { routeTree } from "@/routes";

// In a real Chromium: the board's pages over `memory`, with the app's own routes. Two tabs are
// two scopes; tab B is drawn, tab A only calls.

test("an issue made and moved on one tab moves on the drawn tab", async () => {
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
  await ana.run(issues.api["team.add"], { input: { teamId: "ENG", userId: "bo", role: "member" } });

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
  await expect.element(page.getByRole("article", { name: "ENG-1" })).toBeVisible();
  // P2: four lanes. A new card is in backlog, with its title.
  for (const lane of ["backlog", "todo", "doing", "done"]) {
    // In the page, not "visible": a lane with no card and no heading has no size.
    await expect.element(page.getByRole("region", { name: lane, exact: true })).toBeInTheDocument();
  }
  const backlog = page.getByRole("region", { name: "backlog", exact: true });
  await expect.element(backlog.getByRole("article", { name: "ENG-1" })).toBeVisible();
  expect(backlog.element().textContent).toContain("Login fails");
  // P2: a lane lists its cards by number.
  await page.getByLabelText("New issue").fill("Logout fails");
  await page.getByRole("button", { name: "Add issue" }).click();
  await expect
    .poll(() =>
      [...backlog.element().querySelectorAll("article")].map((a) => a.getAttribute("aria-label")),
    )
    .toEqual(["ENG-1", "ENG-2"]);

  const [made] = ana.resolve(issues.board.issues.where({ teamId: "ENG" })).get();
  const id = made?.id ?? server.resolve(issues.board.issues).get()[0]!.id;
  await ana.run(issues.api["issue.move"], {
    input: { teamId: "ENG", id, version: 1, state: "done" },
  });
  const done = page.getByRole("region", { name: "done" });
  await expect.element(done.getByRole("article", { name: "ENG-1" })).toBeVisible();
  await expect.element(backlog.getByRole("article", { name: "ENG-1" })).not.toBeInTheDocument();

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
  // The server answers with the key it keeps (upper case), and the page opens the team there.
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

  await expect.element(page.getByRole("alert")).toBeVisible();

  await cy.run(issues.api["team.create"], { input: { teamId: "OPS" } });
  await page.getByRole("button", { name: "Try again" }).click();

  await expect.element(page.getByRole("heading", { name: "OPS" })).toBeVisible();

  await cy.close();
  await server.close();
});

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

  await expect.element(page.getByRole("alert")).toBeVisible();
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

  await expect.element(page.getByRole("status")).toBeVisible();
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

  await expect.element(page.getByRole("status")).toBeVisible();
  const backlog = page.getByRole("region", { name: "backlog", exact: true });
  await expect.element(backlog.getByRole("article", { name: "ENG-1" })).toBeVisible();

  await ana.close();
  await server.close();
});

/** A server with the board's ops (some replaced), and ENG with one issue that ana made. The page
 * draws `/issues/ENG` for ana, or for a viewer of ENG when `viewer` names one. */
/** What `issues.api` implements, typed by the contract (not by the ops of this app). */
type Implement = NonNullable<Parameters<typeof issues.api>[0]["implement"]>;

const drawn = async (replace: Partial<Implement> = {}, viewer?: string) => {
  const server = await createScope({
    capsules: [
      exits({ store: localStorage }),
      issues.board({ serve: true, onStart: [signedIn, membersOnly] }),
      issues.api({ implement: { ...issueOps, ...replace }, onStart: [signedIn] }),
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

  const ana = await tab("ana");
  await ana.run(issues.api["team.create"], { input: { teamId: "ENG" } });
  await ana.run(issues.api["issue.create"], { input: { teamId: "ENG", title: "Login fials" } });
  if (viewer) {
    const input = { teamId: "ENG", userId: viewer, role: "viewer" } as const;
    await ana.run(issues.api["team.add"], { input });
  }

  const shown = viewer ? await tab(viewer) : ana;
  const history = createMemoryHistory({ initialEntries: ["/issues/ENG"] });
  const router = createRouter({ routeTree, history, context: { scope: shown } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  onTestFinished(async () => {
    root.unmount();
    await shown.close();
    await ana.close();
    await server.close();
  });
  root.render(
    <ScopeProvider scope={shown}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  return server;
};

// P5: a card's title is renamed in place; the server keeps the new title.
test("a card is renamed in place", async () => {
  const server = await drawn();

  await page.getByLabelText("Title of ENG-1").fill("Login fails");
  await page.getByRole("button", { name: "Rename" }).click();

  await expect.poll(() => server.resolve(issues.board.issues).get()[0]?.title).toBe("Login fails");
  await expect.element(page.getByLabelText("Title of ENG-1")).toHaveValue("Login fails");
});

test("a stale rename says that someone else changed the issue", async () => {
  const stale = operation({
    label: "test.issue.rename.stale",
    input: issues.api["issue.rename"].input,
    run: () => ({ kind: "stale" as const, version: 7 }),
  });
  await drawn({ "issue.rename": stale });

  await page.getByLabelText("Title of ENG-1").fill("Login fails");
  await page.getByRole("button", { name: "Rename" }).click();

  await expect.element(page.getByRole("status")).toBeVisible();
});

// P6: "Archive team" archives the team; a change after it says the team is archived, and the
// board keeps its issues.
test("an archived team says so on the next change", async () => {
  const server = await drawn();

  await page.getByRole("button", { name: "Archive team" }).click();
  await expect.poll(() => server.resolve(issues.board.archived).get()).toHaveLength(1);
  // The archive's own answer may show a status or not: P6 asks only for the next change's.
  const before = page.getByRole("status").elements().length;
  await page.getByLabelText("New issue").fill("Too late");
  await page.getByRole("button", { name: "Add issue" }).click();

  await expect.poll(() => page.getByRole("status").elements().length).toBe(before + 1);
  await expect.element(page.getByRole("article", { name: "ENG-1" })).toBeVisible();
  expect(server.resolve(issues.board.issues).get()).toHaveLength(1);
});

// P7: a viewer sees the board; each change they ask shows a status, and nothing changes.
test("a viewer sees the board, and a change says they can only view", async () => {
  const server = await drawn({}, "vi");

  await expect.element(page.getByRole("article", { name: "ENG-1" })).toBeVisible();
  await page.getByLabelText("New issue").fill("Not mine");
  await page.getByRole("button", { name: "Add issue" }).click();
  await expect.poll(() => page.getByRole("status").elements().length).toBe(1);
  await page.getByLabelText("State of ENG-1").selectOptions("done");
  await expect.poll(() => page.getByRole("status").elements().length).toBe(2);

  await expect.element(page.getByRole("article", { name: "ENG-1" })).toBeVisible();
  expect(server.resolve(issues.board.issues).get()).toMatchObject([{ state: "backlog" }]);
});

// P2: the member form names a role: a person added as a viewer is kept as one.
test("the member form adds a person as a viewer", async () => {
  const server = await drawn();

  await page.getByRole("textbox", { name: "Add member" }).fill("vi");
  await page.getByRole("combobox", { name: "Role", exact: true }).selectOptions("viewer");
  await page.getByRole("button", { name: "Add member" }).click();

  await expect
    .poll(() =>
      server
        .resolve(issues.board.members)
        .get()
        .map((m) => `${m.userId} ${m.role}`),
    )
    .toContain("vi viewer");
});

// P8: a card's label form puts a label on it; each label is a button that takes it off. The
// filter above the lanes shows only the issues with one label.
test("a label is put on a card and taken off; the filter shows only its issues", async () => {
  const server = await drawn();
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  onTestFinished(async () => {
    await ana.close();
  });
  await ana.run(issues.api["issue.create"], { input: { teamId: "ENG", title: "Logout fails" } });
  const one = page.getByRole("article", { name: "ENG-1" });
  const two = page.getByRole("article", { name: "ENG-2" });
  await expect.element(two).toBeVisible();

  await one.getByLabelText("Label for ENG-1").fill("bug");
  await one.getByRole("button", { name: "Add label" }).click();
  await expect.element(one.getByRole("button", { name: "Remove bug from ENG-1" })).toBeVisible();
  await expect
    .poll(() =>
      server
        .resolve(issues.board.labels)
        .get()
        .map((t) => t.name),
    )
    .toEqual(["bug"]);

  const filter = page.getByRole("combobox", { name: "Show label", exact: true });
  await filter.selectOptions("bug");
  await expect.element(two).not.toBeInTheDocument();
  await expect.element(one).toBeVisible();
  await filter.selectOptions("all");
  await expect.element(two).toBeVisible();

  await one.getByRole("button", { name: "Remove bug from ENG-1" }).click();
  await expect.poll(() => server.resolve(issues.board.labels).get()).toEqual([]);
  await expect
    .element(one.getByRole("button", { name: "Remove bug from ENG-1" }))
    .not.toBeInTheDocument();
});

// P8: a label put on by another tab shows on the drawn card, and in the filter.
test("a label put on by another tab shows on the card and in the filter", async () => {
  const server = await drawn();
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  onTestFinished(async () => {
    await ana.close();
  });
  const { id } = server.resolve(issues.board.issues).get()[0]!;

  const input = { teamId: "ENG", id, version: 1, name: "ui", on: true };
  expect(await ana.run(issues.api["issue.label"], { input })).toEqual({
    kind: "labeled",
    version: 2,
  });

  await expect.element(page.getByRole("button", { name: "Remove ui from ENG-1" })).toBeVisible();
  const filter = page.getByRole("combobox", { name: "Show label", exact: true });
  await expect
    .poll(() => [...filter.element().querySelectorAll("option")].map((o) => o.text))
    .toEqual(["all", "ui"]);
});

// P9: a card's select `Assignee of ENG-1` lists `nobody`, then the team's members (not its
// viewers). A choice assigns the issue.
test("a card is assigned to a member of the team, and back to nobody", async () => {
  const server = await drawn({}, undefined);
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  onTestFinished(async () => {
    await ana.close();
  });
  const who = page.getByRole("combobox", { name: "Assignee of ENG-1", exact: true });
  const options = () => [...who.element().querySelectorAll("option")].map((o) => o.text);
  await ana.run(issues.api["team.add"], { input: { teamId: "ENG", userId: "bo", role: "member" } });
  await expect.poll(options).toEqual(["nobody", "ana", "bo"]);
  await ana.run(issues.api["team.add"], { input: { teamId: "ENG", userId: "vi", role: "viewer" } });
  await ana.run(issues.api["team.add"], { input: { teamId: "ENG", userId: "cy", role: "member" } });
  await expect.poll(options).toEqual(["nobody", "ana", "bo", "cy"]);

  await who.selectOptions("bo");
  await expect.poll(() => server.resolve(issues.board.issues).get()[0]?.assignee).toBe("bo");
  await expect.element(who).toHaveValue("bo");
  await who.selectOptions("nobody");
  await expect.poll(() => server.resolve(issues.board.issues).get()[0]?.version).toBe(3);
  expect(server.resolve(issues.board.issues).get()[0]?.assignee).toBeUndefined();
});

// P10: `/issues/mine` lists, for each team the person is in, the issues assigned to them, live.
test("my issues lists the issues assigned to me in each of my teams, live", async () => {
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
  const made = async (teamId: string, title: string) => {
    await ana.run(issues.api["issue.create"], { input: { teamId, title } });
    const it = server
      .resolve(issues.board.issues)
      .get()
      .find((i) => i.teamId === teamId && i.title === title)!;
    return { teamId, id: it.id, version: 1 };
  };
  for (const teamId of ["WEB", "API"]) {
    await ana.run(issues.api["team.create"], { input: { teamId } });
    await ana.run(issues.api["team.add"], { input: { teamId, userId: "bo", role: "member" } });
  }
  await ana.run(issues.api["issue.assign"], {
    input: { ...(await made("WEB", "Header")), userId: "bo" },
  });
  await made("WEB", "Footer");
  await ana.run(issues.api["issue.assign"], {
    input: { ...(await made("API", "Auth")), userId: "bo" },
  });

  const history = createMemoryHistory({ initialEntries: ["/issues/mine"] });
  const router = createRouter({ routeTree, history, context: { scope: bo } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  onTestFinished(async () => {
    root.unmount();
    await ana.close();
    await bo.close();
    await server.close();
  });
  root.render(
    <ScopeProvider scope={bo}>
      <RouterProvider router={router} />
    </ScopeProvider>,
  );

  await expect.element(page.getByRole("heading", { name: "My issues" })).toBeVisible();
  const web = page.getByRole("region", { name: "WEB", exact: true });
  const api = page.getByRole("region", { name: "API", exact: true });
  await expect.element(web.getByRole("article", { name: "WEB-1" })).toBeVisible();
  await expect.element(api.getByRole("article", { name: "API-1" })).toBeVisible();
  expect(web.getByRole("article", { name: "WEB-2" }).elements()).toEqual([]);
  // The teams in order of their key.
  expect(
    [...document.querySelectorAll("main section")].map((x) => x.getAttribute("aria-label")),
  ).toEqual(["API", "WEB"]);

  // A team that adds bo, and an issue it assigns to bo, show at once.
  await ana.run(issues.api["team.create"], { input: { teamId: "OPS" } });
  await ana.run(issues.api["team.add"], { input: { teamId: "OPS", userId: "bo", role: "member" } });
  await ana.run(issues.api["issue.assign"], {
    input: { ...(await made("OPS", "Pager")), userId: "bo" },
  });
  const ops = page.getByRole("region", { name: "OPS", exact: true });
  await expect.element(ops.getByRole("article", { name: "OPS-1" })).toBeVisible();
  // An issue taken off bo goes.
  const [header] = server
    .resolve(issues.board.issues)
    .get()
    .filter((i) => i.title === "Header");
  await ana.run(issues.api["issue.assign"], {
    input: { teamId: "WEB", id: header!.id, version: 2, userId: null },
  });
  await expect.element(web.getByRole("article", { name: "WEB-1" })).not.toBeInTheDocument();
});

// P11: the board's region `History` lists each event of the team, by issue number, then version,
// live.
test("the history lists each change of the team's issues, live", async () => {
  const server = await drawn();
  const ana = await createScope({
    capsules: [
      exits({ store: localStorage }),
      memory.client({ peer: server, meta: whoMeta }),
      issues.board({ read: memory.client }),
      issues.api({ remote: memory.client }),
    ],
  }).ready;
  ana.run(signIn, { input: { name: "ana" } });
  onTestFinished(async () => {
    await ana.close();
  });
  await ana.run(issues.api["issue.create"], { input: { teamId: "ENG", title: "Second" } });
  const { id } = server
    .resolve(issues.board.issues)
    .get()
    .find((i) => i.number === 1)!;
  await ana.run(issues.api["issue.move"], {
    input: { teamId: "ENG", id, version: 1, state: "todo" },
  });
  const one = page.getByRole("article", { name: "ENG-1" });
  await expect.element(one.getByLabelText("Title of ENG-1")).toBeVisible();
  await one.getByLabelText("Title of ENG-1").fill("Login fails");
  await one.getByRole("button", { name: "Rename" }).click();

  const history = page.getByRole("region", { name: "History", exact: true });
  await expect
    .poll(() => [...history.element().querySelectorAll("li")].map((li) => li.textContent))
    .toEqual([
      "ENG-1 v1 created by ana",
      "ENG-1 v2 moved by ana",
      "ENG-1 v3 renamed by ana",
      "ENG-2 v1 created by ana",
    ]);
});

// P12: "Delete team" deletes the team and opens `/issues`.
test("delete team takes the team away and opens the home page", async () => {
  const server = await drawn();
  await expect.element(page.getByRole("article", { name: "ENG-1" })).toBeVisible();

  await page.getByRole("button", { name: "Delete team" }).click();

  await expect.element(page.getByLabelText("Team key")).toBeVisible();
  await expect.poll(() => server.resolve(issues.board.members).get()).toEqual([]);
  expect(server.resolve(issues.board.issues).get()).toEqual([]);
  expect(server.resolve(issues.board.events).get()).toEqual([]);
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
  await expect.poll(() => said().length).toBe(1);
  const before = said();

  await page.getByRole("textbox", { name: "Add member" }).fill("cy");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect.poll(said).not.toEqual(before);

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
  await expect.element(page.getByRole("alert")).toBeVisible();

  const failed = spans.find((span) => span.name === "issue.create.boom");
  expect(page.getByRole("alert").element().textContent).toContain(failed?.traceId.slice(0, 8));
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

  await expect.element(page.getByRole("status")).toBeVisible();
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
/** Kit: ana's member row on a bare reads server. */
const anaJoins = operation({
  label: "test.issues.anaJoins",
  depends: { members: members.controller },
  run: ({ members }) => members.set({ teamId: "ENG", userId: "ana", role: "member" }),
});

const pageOf = operation({
  label: "test.issues.page",
  input: z.custom<{ reads: Scope.Handle; api: Scope.Handle }>(),
  run: async (_, { input }) => {
    // Kit: the reads server holds ana's member row, as in real use (the read hook lets only a
    // member read the team), so a page may check that the caller is in the team.
    input.reads.run(anaJoins);
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

  await expect.element(page.getByRole("status")).toBeVisible();

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

  await expect.element(page.getByRole("status")).toBeVisible();

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

  await expect.element(page.getByRole("alert")).toBeVisible();

  await ana.close();
  await server.close();
});
