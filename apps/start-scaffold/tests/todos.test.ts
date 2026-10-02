import { proofDatabase, proofMail } from "@tinker-start-scaffold/proof";
import { test, expect } from "vite-plus/test";
import { createScope, isError as isCoreError } from "@tinker/core";
import {
  authSettings,
  databaseSettings,
  mailSettings,
  handleAuth,
  requestHeaders,
  listTodos,
  changeTodo,
  migrate,
  raise,
  isError,
} from "@tinker-start-scaffold/backend";
const tags = [
  databaseSettings({ url: "postgres://proof", migrations: "drizzle" }),
  mailSettings({
    host: "proof",
    port: 25,
    user: "proof",
    password: "proof",
    from: "proof@example.com",
  }),
  authSettings({
    origin: "http://localhost:4318",
    secret: "test-secret-with-at-least-thirty-two-letters",
    plugins: [],
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
  const root = createScope({ signal: stop.signal, tags, presets: [proofDatabase, proofMail] });
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
    await root.run(changeTodo, {
      rawInput: {
        executionId: crypto.randomUUID(),
        change: { kind: "add", title: "  Write code  " },
      },
      tags: requestHeaders(ada),
    });
    await root.run(changeTodo, {
      input: { executionId: crypto.randomUUID(), change: { kind: "add", title: "Find a bug" } },
      tags: requestHeaders(grace),
    });
    const adaRows = await root.run(listTodos, { tags: requestHeaders(ada) });
    const adaTodo = adaRows.at(0);
    if (!adaTodo) raise("BadInput", { reason: "missing saved todo" });
    expect(adaRows).toEqual([{ id: adaTodo.id, title: "Write code", done: false }]);
    const graceRows = await root.run(listTodos, { tags: requestHeaders(grace) });
    expect(graceRows.map((row) => row.title)).toEqual(["Find a bug"]);
    for (const id of [adaTodo.id, 2_147_483_647]) {
      for (const input of [
        { kind: "setDone", id, done: true } as const,
        { kind: "delete", id } as const,
      ]) {
        const result = await root.settle(changeTodo, {
          input: { executionId: crypto.randomUUID(), change: input },
          tags: requestHeaders(grace),
        });
        if (result.status !== "failed")
          raise("BadInput", { reason: "expected private todo refusal" });
        if (!isError(result.error, "TodoMissing")) throw result.error;
      }
    }
    expect(await root.run(listTodos, { tags: requestHeaders(ada) })).toEqual(adaRows);
    await root.run(changeTodo, {
      input: {
        executionId: crypto.randomUUID(),
        change: { kind: "setDone", id: adaTodo.id, done: true },
      },
      tags: requestHeaders(ada),
    });
    await root.run(changeTodo, {
      input: {
        executionId: crypto.randomUUID(),
        change: { kind: "setDone", id: adaTodo.id, done: true },
      },
      tags: requestHeaders(ada),
    });
    expect(await root.run(listTodos, { tags: requestHeaders(ada) })).toEqual([
      { ...adaTodo, done: true },
    ]);
    await root.run(changeTodo, {
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
    signal: stop.signal,
    tags,
    presets: [proofDatabase, proofMail],
    observe: { history: 80 },
  });
  await root.ready;
  try {
    await root.run(migrate);
    const result = await root.settle(changeTodo, {
      input: { executionId: crypto.randomUUID(), change: { kind: "add", title: "No account" } },
      tags: requestHeaders(new Headers()),
    });
    if (result.status !== "failed") raise("BadInput", { reason: "expected sign-in refusal" });
    if (!isError(result.error, "SignInRequired")) throw result.error;
    const read = await root.settle(listTodos, { tags: requestHeaders(new Headers()) });
    if (read.status !== "failed") raise("BadInput", { reason: "expected private list refusal" });
    if (!isError(read.error, "SignInRequired")) throw read.error;
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});

test("todo changes reject empty titles, long titles, and caller-selected owners", async () => {
  const stop = new AbortController();
  const root = createScope({ signal: stop.signal });
  await root.ready;
  try {
    for (const rawInput of [
      { kind: "add", title: "   " },
      { kind: "add", title: "x".repeat(201) },
      { kind: "add", title: "Valid title", ownerId: "someone-else" },
    ]) {
      const result = await root.settle(changeTodo, {
        rawInput: { executionId: crypto.randomUUID(), change: rawInput },
      });
      if (result.status !== "failed") raise("BadInput", { reason: "expected input refusal" });
      if (!isCoreError(result.error, "DataValidationFailed")) throw result.error;
      const cause = result.error.payload.cause;
      if (!isError(cause, "BadInput")) throw cause;
      expect(cause.payload.reason).toContain("valid todo change");
    }
  } finally {
    stop.abort();
    expect((await root.closed).status).toBe("success");
  }
});
