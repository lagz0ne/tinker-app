import { createScope } from "@tinker/core";
import { test, expect } from "vite-plus/test";

import { authStartup } from "~/components/auth/index.server";
import { authSettings } from "~/components/auth/index.server";
import { migrate, databaseUrl } from "~/components/database/index.server";
import { backendStop as requestHostStop } from "~/components/requests";
import { startRequests } from "~/components/requests";
import { bootstrapSlot, readAccountSlot } from "~/components/sync/index.server";

import { readAccount } from "@/demo/backend/auth.server";
import { bootstrap } from "@/demo/backend/sync.server";
import { listTodos, changeTodo } from "@/demo/backend/todos.server";

import { handleAuth } from "./presets";
import { proofDatabase, proofMail, requestHeaders } from "./presets";
import { write, settleWrite } from "./write-boundary";

const requestBindings = requestHostStop(new AbortController().signal);

const tags = [
  [bootstrapSlot(bootstrap), readAccountSlot(readAccount)],
  databaseUrl(new URL("postgres://proof")),
  authSettings({
    origin: "http://localhost:4318",
    secret: "test-secret-with-at-least-thirty-two-letters",
  }),
];

function signupRequest(name: string) {
  return new Request("http://localhost:4318/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:4318" },
    body: JSON.stringify({ name, email: `${name}@example.com`, password: "safe-password-42" }),
  });
}

function readHeaders(response: Response) {
  return new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";").at(0))
      .join("; "),
  });
}

test("two real accounts can change only their own saved todos", async () => {
  const stop = new AbortController();
  const root = createScope({
    extensions: [startRequests, authStartup],
    signal: stop.signal,
    tags: [requestBindings, tags],
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);

    const ada = readHeaders(
      await root.run(handleAuth, {
        input: signupRequest("Ada"),
        tags: requestHeaders(new Headers()),
      }),
    );
    const grace = readHeaders(
      await root.run(handleAuth, {
        input: signupRequest("Grace"),
        tags: requestHeaders(new Headers()),
      }),
    );

    await write(root, changeTodo, {
      rawInput: {
        executionId: crypto.randomUUID(),
        change: { kind: "add", title: "  Write code  " },
      },
      tags: requestHeaders(ada),
    });
    await write(root, changeTodo, {
      input: { executionId: crypto.randomUUID(), change: { kind: "add", title: "Find a bug" } },
      tags: requestHeaders(grace),
    });

    const adaRows = await root.run(listTodos, { tags: requestHeaders(ada) });
    const adaTodo = adaRows.at(0);
    if (!adaTodo) return expect.unreachable("missing saved todo");
    expect(adaRows).toEqual([{ id: adaTodo.id, title: "Write code", done: false }]);
    const graceRows = await root.run(listTodos, { tags: requestHeaders(grace) });
    expect(graceRows.map((row) => row.title)).toEqual(["Find a bug"]);

    for (const id of [adaTodo.id, 2_147_483_647]) {
      for (const input of [
        { kind: "setDone", id, done: true } as const,
        { kind: "delete", id } as const,
      ]) {
        const result = await settleWrite(root, changeTodo, {
          input: { executionId: crypto.randomUUID(), change: input },
          tags: requestHeaders(grace),
        });
        expect(result).toMatchObject({
          status: "failed",
          kind: "error",
          error: { kind: "TodoMissing" },
        });
      }
    }

    expect(await root.run(listTodos, { tags: requestHeaders(ada) })).toEqual(adaRows);

    await write(root, changeTodo, {
      input: {
        executionId: crypto.randomUUID(),
        change: { kind: "setDone", id: adaTodo.id, done: true },
      },
      tags: requestHeaders(ada),
    });
    await write(root, changeTodo, {
      input: {
        executionId: crypto.randomUUID(),
        change: { kind: "setDone", id: adaTodo.id, done: true },
      },
      tags: requestHeaders(ada),
    });

    expect(await root.run(listTodos, { tags: requestHeaders(ada) })).toEqual([
      { ...adaTodo, done: true },
    ]);

    await write(root, changeTodo, {
      input: { executionId: crypto.randomUUID(), change: { kind: "delete", id: adaTodo.id } },
      tags: requestHeaders(ada),
    });

    expect(await root.run(listTodos, { tags: requestHeaders(ada) })).toEqual([]);
    expect(await root.run(listTodos, { tags: requestHeaders(grace) })).toEqual(graceRows);
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("signed-out todo reads and writes are refused", async () => {
  const stop = new AbortController();
  const root = createScope({
    extensions: [startRequests, authStartup],
    signal: stop.signal,
    tags: [requestBindings, tags],
    presets: [proofDatabase, proofMail],
    observe: { history: 80 },
  });
  await root.ready;
  try {
    await root.run(migrate);

    const result = await settleWrite(root, changeTodo, {
      input: { executionId: crypto.randomUUID(), change: { kind: "add", title: "No account" } },
      tags: requestHeaders(new Headers()),
    });
    expect(result).toMatchObject({
      status: "failed",
      kind: "error",
      error: { kind: "SignInRequired" },
    });

    const read = await root.settle(listTodos, { tags: requestHeaders(new Headers()) });
    expect(read).toMatchObject({
      status: "failed",
      kind: "error",
      error: { kind: "SignInRequired" },
    });
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("todo changes reject empty titles, long titles, and caller-selected owners", async () => {
  const stop = new AbortController();
  const root = createScope({
    tags: [requestBindings, tags],
    extensions: [startRequests, authStartup],
    signal: stop.signal,
    presets: [proofDatabase, proofMail],
  });
  await root.ready;
  try {
    await root.run(migrate);
    const ada = readHeaders(
      await root.run(handleAuth, {
        input: signupRequest("Ada"),
        tags: requestHeaders(new Headers()),
      }),
    );
    for (const rawInput of [
      { kind: "add", title: "   " },
      { kind: "add", title: "x".repeat(201) },
      { kind: "add", title: "Valid title", ownerId: "someone-else" },
    ]) {
      const result = await settleWrite(root, changeTodo, {
        rawInput: { executionId: crypto.randomUUID(), change: rawInput },
        tags: requestHeaders(ada),
      });
      expect(result).toMatchObject({
        status: "failed",
        kind: "error",
        error: expect.objectContaining({
          kind: "BadInput",
          payload: { reason: "Use a title with 1 to 200 characters and a valid todo change." },
        }),
      });
    }
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
