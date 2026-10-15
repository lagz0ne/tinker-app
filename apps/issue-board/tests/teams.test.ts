import { createScope, type Scope } from "@tinker/core";
import { beforeEach, afterEach, test, expect } from "vite-plus/test";

import { authStartup, authSettings } from "~/components/auth/index.server";
import { migrate, databaseUrl } from "~/components/database/index.server";
import { startRequests, backendStop } from "~/components/requests";
import { bootstrapSlot, readAccountSlot } from "~/components/sync/index.server";

import { changeTeam, readTeam, listTeams } from "@/backend/teams.server";
import { readAccount } from "@/demo/backend/auth.server";
import { bootstrap } from "@/demo/backend/sync.server";
import { isError } from "@/demo/errors";

import { authBindings, handleAuth, proofDatabase, proofMail, requestHeaders } from "./presets";

let stop: AbortController;
let root: Scope.RootHandle;
let ada: Headers;
let grace: Headers;

beforeEach(async () => {
  stop = new AbortController();
  root = createScope({
    signal: stop.signal,
    extensions: [startRequests, authStartup],
    presets: [proofDatabase, proofMail],
    tags: [
      backendStop(stop.signal),
      authBindings,
      bootstrapSlot(bootstrap),
      readAccountSlot(readAccount),
      databaseUrl(new URL("postgres://proof")),
      authSettings({
        origin: "http://localhost:4318",
        secret: "test-secret-with-at-least-thirty-two-letters",
      }),
    ],
  });
  await root.ready;
  await root.run(migrate);

  const headers: Headers[] = [];
  for (const name of ["ada", "grace"]) {
    const response = await root.run(handleAuth, {
      input: new Request("http://localhost:4318/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:4318" },
        body: JSON.stringify({ name, email: `${name}@example.com`, password: "safe-password-42" }),
      }),
      tags: requestHeaders(new Headers()),
    });
    expect(response.status).toBe(200);
    headers.push(
      new Headers({
        cookie: response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; "),
      }),
    );
  }
  [ada, grace] = headers as [Headers, Headers];
});

afterEach(async () => {
  stop.abort();
  expect((await root.closed).status).toBe("success");
});

test("a non-member reading a team gets NotTeamMember", async () => {
  await root.run(changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "create", key: "ENG", name: "Engineering" },
    },
    tags: requestHeaders(ada),
  });
  const [team] = await root.run(listTeams, { tags: requestHeaders(ada) });

  const result = await root.settle(readTeam, {
    rawInput: { teamId: team!.id },
    tags: requestHeaders(grace),
  });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") throw new Error("Expected refusal");
  expect(isError(result.error, "NotTeamMember")).toBe(true);
  expect(await root.run(listTeams, { tags: requestHeaders(grace) })).toEqual([]);
});

test("a team key clash is rejected and leaves one team", async () => {
  for (const [index, headers] of [ada, grace].entries()) {
    const result = await root.settle(changeTeam, {
      rawInput: {
        executionId: crypto.randomUUID(),
        change: { kind: "create", key: index ? "eng" : "ENG", name: "Engineering" },
      },
      tags: requestHeaders(headers),
    });
    if (index === 0) expect(result.status).toBe("success");
    else {
      expect(result.status).toBe("failed");
      if (result.status !== "failed") throw new Error("Expected key clash");
      expect(isError(result.error, "TeamKeyTaken")).toBe(true);
    }
  }

  expect(await root.run(listTeams, { tags: requestHeaders(ada) })).toHaveLength(1);
  expect(await root.run(listTeams, { tags: requestHeaders(grace) })).toEqual([]);
});

test("an admin adds an existing user; retries keep one membership and members cannot add people", async () => {
  const create = {
    executionId: crypto.randomUUID(),
    change: { kind: "create", key: "ENG", name: "Engineering" },
  };
  await root.run(changeTeam, { rawInput: create, tags: requestHeaders(ada) });
  await root.run(changeTeam, { rawInput: create, tags: requestHeaders(ada) });
  const [team] = await root.run(listTeams, { tags: requestHeaders(ada) });
  const add = {
    executionId: crypto.randomUUID(),
    change: { kind: "addMember", teamId: team!.id, email: "GRACE@example.com" },
  };
  await root.run(changeTeam, { rawInput: add, tags: requestHeaders(ada) });
  await root.run(changeTeam, { rawInput: add, tags: requestHeaders(ada) });

  expect(
    await root.run(readTeam, { rawInput: { teamId: team!.id }, tags: requestHeaders(grace) }),
  ).toEqual({ ...team, role: "member" });
  expect(await root.run(listTeams, { tags: requestHeaders(grace) })).toHaveLength(1);
  const state = await root.run(bootstrap, { tags: requestHeaders(grace) });
  expect(state.private?.teams).toEqual([{ ...team, role: "member" }]);

  const refused = await root.settle(changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "addMember", teamId: team!.id, email: "ada@example.com" },
    },
    tags: requestHeaders(grace),
  });
  expect(refused.status).toBe("failed");
  if (refused.status !== "failed") throw new Error("Expected admin check");
  expect(isError(refused.error, "TeamAdminRequired")).toBe(true);
});

test("adding an unknown email is rejected without a change", async () => {
  await root.run(changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "create", key: "ENG", name: "Engineering" },
    },
    tags: requestHeaders(ada),
  });
  const [team] = await root.run(listTeams, { tags: requestHeaders(ada) });

  const result = await root.settle(changeTeam, {
    rawInput: {
      executionId: crypto.randomUUID(),
      change: { kind: "addMember", teamId: team!.id, email: "missing@example.com" },
    },
    tags: requestHeaders(ada),
  });
  expect(result.status).toBe("failed");
  if (result.status !== "failed") throw new Error("Expected existing account check");
  expect(isError(result.error, "UserNotFound")).toBe(true);
});
